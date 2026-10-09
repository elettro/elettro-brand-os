import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import { handler as existingHandler } from "./db-main.mjs";

const { Client } = pg;
const secrets = new SecretsManagerClient({});

const DROPBOX_BRAND_ROOTS = [
  ["solarmeister", "/1---elettro-brand-os/solarmeister"],
  ["stashbox", "/1---elettro-brand-os/stashbox"],
  ["weightlossdavie", "/1---elettro-brand-os/weightlossdavie"],
  ["neckermann-strom", "/1---elettro-brand-os/neckermann-strom"],
  ["therasbox", "/1---elettro-brand-os/therasbox"],
  ["elettro", "/1---elettro-brand-os/elettro"]
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function assetKindFromName(name = "") {
  const lower = name.toLowerCase();
  if (/\.(mp4|mov|m4v|avi|webm|mkv)$/i.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif|tif|tiff|heic|avif)$/i.test(lower)) return "image";
  return null;
}

function brandSlugForDropboxPath(pathLower = "") {
  const normalized = pathLower.toLowerCase();
  const match = [...DROPBOX_BRAND_ROOTS]
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, root]) => normalized === root || normalized.startsWith(`${root}/`));
  return match?.[0] ?? null;
}

async function connectDatabase() {
  const secretId = process.env.DB_SECRET_NAME;
  const hostOverride = process.env.DB_HOST;

  if (!secretId) {
    throw new Error("DB_SECRET_NAME is not configured");
  }

  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );

  if (!response.SecretString) {
    throw new Error("Database secret has no SecretString value");
  }

  const secret = JSON.parse(response.SecretString);
  const host = hostOverride || secret.host;
  const port = Number(secret.port || 5432);
  const database = secret.dbname || secret.database || "postgres";
  const user = secret.username;
  const password = secret.password;

  if (!host || !user || !password) {
    throw new Error("Database secret is missing host/username/password");
  }

  const client = new Client({
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    query_timeout: 10000
  });

  await client.connect();
  return client;
}


function folderHintsFromPath(sourcePath = "", brandSlug = "") {
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const root = `/1---elettro-brand-os/${brandSlug.toLowerCase()}/`;
  const start = lower.indexOf(root);
  const relative = start >= 0 ? normalized.slice(start + root.length) : normalized.replace(/^\/+/, "");
  const parts = relative.split("/").filter(Boolean);
  const filename = parts.pop() || "";
  const typeHint = parts[0] || null;
  const topicHint = parts[1] || null;
  const ratioHint = parts.find((part) => /^\d{1,2}x\d{1,2}$/i.test(part)) || null;

  return {
    folderPath: parts.join("/"),
    typeHint,
    topicHint,
    aspectRatioLabel: ratioHint,
    filename
  };
}

async function backfillFolderHints(event) {
  let client;
  try {
    client = await connectDatabase();

    const limit = Math.min(Math.max(Number(event?.limit || 500), 1), 1000);
    const rows = await client.query(
      `SELECT
         a."id",
         a."sourcePath",
         a."aspectRatioLabel",
         b."slug" AS "brandSlug"
       FROM "Asset" a
       JOIN "Brand" b ON b."id" = a."brandId"
       WHERE a."sourceType" = 'dropbox'
         AND a."retiredAt" IS NULL
         AND a."ingestStatus" IN ('raw','needs_metadata')
       ORDER BY a."createdAt" ASC
       LIMIT $1`,
      [limit]
    );

    let updated = 0;
    for (const row of rows.rows) {
      const hints = folderHintsFromPath(row.sourcePath || "", row.brandSlug || "");
      await client.query(
        `UPDATE "Asset"
         SET "folderSuggestions" = $2::jsonb,
             "aspectRatioLabel" = COALESCE("aspectRatioLabel", $3),
             "ingestStatus" = 'needs_metadata',
             "enrichmentStatus" = 'suggested',
             "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [row.id, JSON.stringify(hints), hints.aspectRatioLabel]
      );
      updated += 1;
    }

    return json(200, {
      ok: true,
      message: "Folder hints backfilled",
      scanned: rows.rowCount,
      updated
    });
  } catch (error) {
    console.error("[metadata-backfill] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown metadata backfill error"
    });
  } finally {
    if (client) {
      try { await client.end(); } catch {}
    }
  }
}


function normalizeBulkMetadata(input = {}) {
  const clean = {};
  const copy = (key) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = input[key];
      clean[key] = typeof value === "string" ? value.trim() || null : value;
    }
  };

  ["title", "topic", "contentGroup", "creativeFamily", "priority", "eligibilityType", "creativeNotes"].forEach(copy);

  if (Object.prototype.hasOwnProperty.call(input, "tags")) {
    const seen = new Set();
    clean.tags = Array.isArray(input.tags)
      ? input.tags
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .filter((value) => {
            const key = value.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(input, "commerceLinks")) {
    const seenLinks = new Set();
    clean.commerceLinks = Array.isArray(input.commerceLinks)
      ? input.commerceLinks
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .filter((value) => {
            const key = value.toLowerCase();
            if (seenLinks.has(key)) return false;
            seenLinks.add(key);
            return true;
          })
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(input, "containsSpecificPricing")) {
    clean.containsSpecificPricing = Boolean(input.containsSpecificPricing);
    if (clean.containsSpecificPricing) clean.eligibilityType = "one_time";
  }

  if (Object.prototype.hasOwnProperty.call(input, "allowedDestinations")) {
    clean.allowedDestinations = Array.isArray(input.allowedDestinations)
      ? input.allowedDestinations.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(input, "excludedDestinations")) {
    clean.excludedDestinations = Array.isArray(input.excludedDestinations)
      ? input.excludedDestinations.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(input, "eligibleFrom")) {
    clean.eligibleFrom = input.eligibleFrom || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "eligibleUntil")) {
    clean.eligibleUntil = input.eligibleUntil || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "annualFromMmdd")) {
    clean.annualFromMmdd = input.annualFromMmdd || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "annualUntilMmdd")) {
    clean.annualUntilMmdd = input.annualUntilMmdd || null;
  }

  return clean;
}

async function bulkUpdateAssets(event) {
  let client;
  try {
    client = await connectDatabase();

    let body = event?.body;
    if (typeof body === "string") {
      body = body ? JSON.parse(body) : {};
    }
    body = body || {};

    const assetIds = Array.isArray(body.assetIds)
      ? body.assetIds.filter((id) => typeof id === "string" && id.trim())
      : [];

    if (!assetIds.length) {
      return json(400, { ok: false, error: "assetIds is required" });
    }

    const metadata = normalizeBulkMetadata(body.metadata || {});
    const values = [assetIds];
    const sets = [];
    let param = 2;

    const addSet = (column, value, cast = "") => {
      sets.push('"' + column + '" = ' + String.fromCharCode(36) + param + cast);
      values.push(value);
      param += 1;
    };

    if (Object.prototype.hasOwnProperty.call(metadata, "title")) addSet("title", metadata.title);
    if (Object.prototype.hasOwnProperty.call(metadata, "topic")) addSet("topic", metadata.topic);
    if (Object.prototype.hasOwnProperty.call(metadata, "contentGroup")) addSet("contentGroup", metadata.contentGroup);
    if (Object.prototype.hasOwnProperty.call(metadata, "creativeFamily")) addSet("creativeFamily", metadata.creativeFamily);
    if (Object.prototype.hasOwnProperty.call(metadata, "priority")) addSet("priority", metadata.priority);
    if (Object.prototype.hasOwnProperty.call(metadata, "eligibilityType")) addSet("eligibilityType", metadata.eligibilityType, '::"EligibilityType"');
    if (Object.prototype.hasOwnProperty.call(metadata, "eligibleFrom")) addSet("eligibleFrom", metadata.eligibleFrom, "::date");
    if (Object.prototype.hasOwnProperty.call(metadata, "eligibleUntil")) addSet("eligibleUntil", metadata.eligibleUntil, "::date");
    if (Object.prototype.hasOwnProperty.call(metadata, "annualFromMmdd")) addSet("annualFromMmdd", metadata.annualFromMmdd);
    if (Object.prototype.hasOwnProperty.call(metadata, "annualUntilMmdd")) addSet("annualUntilMmdd", metadata.annualUntilMmdd);
    if (Object.prototype.hasOwnProperty.call(metadata, "creativeNotes")) addSet("creativeNotes", metadata.creativeNotes);
    if (Object.prototype.hasOwnProperty.call(metadata, "tags")) addSet("tags", metadata.tags);
    if (Object.prototype.hasOwnProperty.call(metadata, "commerceLinks")) addSet("commerceLinks", metadata.commerceLinks);
    if (Object.prototype.hasOwnProperty.call(metadata, "containsSpecificPricing")) addSet("containsSpecificPricing", metadata.containsSpecificPricing);
    if (Object.prototype.hasOwnProperty.call(metadata, "allowedDestinations")) addSet("allowedDestinations", metadata.allowedDestinations);
    if (Object.prototype.hasOwnProperty.call(metadata, "excludedDestinations")) addSet("excludedDestinations", metadata.excludedDestinations);

    sets.push('"enrichmentStatus" = \'reviewed\'::"EnrichmentStatus"');

    if (body.markReady) {
      sets.push('"ingestStatus" = \'ready\'::"IngestStatus"');
      sets.push('"firstApprovedAt" = COALESCE("firstApprovedAt", CURRENT_TIMESTAMP)');
    } else {
      sets.push('"ingestStatus" = CASE WHEN "ingestStatus" = \'raw\' THEN \'needs_metadata\'::"IngestStatus" ELSE "ingestStatus" END');
    }

    sets.push('"updatedAt" = CURRENT_TIMESTAMP');

    const result = await client.query(
      `UPDATE "Asset"
       SET ${sets.join(", ")}
       WHERE "id" = ANY($1::uuid[])
         AND "retiredAt" IS NULL
       RETURNING "id","ingestStatus","enrichmentStatus"`,
      values
    );

    return json(200, {
      ok: true,
      updated: result.rowCount,
      assets: result.rows
    });
  } catch (error) {
    console.error("[bulk-metadata] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown bulk metadata error"
    });
  } finally {
    if (client) {
      try { await client.end(); } catch {}
    }
  }
}

async function ingestDropboxPage(event) {
  let client;

  try {
    client = await connectDatabase();

    const organization = await client.query(
      'SELECT "id" FROM "Organization" WHERE "slug" = $1 LIMIT 1',
      ["elettro"]
    );

    if (!organization.rows[0]) {
      throw new Error("Elettro organization not found");
    }

    const organizationId = organization.rows[0].id;

    const connection = await client.query(
      'SELECT "id" FROM "StorageConnection" WHERE "organizationId" = $1 AND "provider" = $2 LIMIT 1',
      [organizationId, "dropbox"]
    );

    if (!connection.rows[0]) {
      throw new Error("Dropbox connection is not registered. Run register-dropbox first.");
    }

    const storageConnectionId = connection.rows[0].id;
    const entries = Array.isArray(event.entries) ? event.entries : [];

    const brandRows = await client.query(
      'SELECT "id","slug" FROM "Brand" WHERE "organizationId" = $1',
      [organizationId]
    );

    const brandIdBySlug = new Map(
      brandRows.rows.map((row) => [row.slug, row.id])
    );

    const rootRows = await client.query(
      'SELECT "id","brandId" FROM "BrandStorageRoot" WHERE "storageConnectionId" = $1',
      [storageConnectionId]
    );

    const rootByBrandId = new Map(
      rootRows.rows.map((row) => [row.brandId, row.id])
    );

    let indexed = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (entry?.[".tag"] !== "file") continue;

      const kind = assetKindFromName(entry.name);
      if (!kind) {
        skipped += 1;
        continue;
      }

      const pathLower = (entry.path_lower || "").toLowerCase();
      const brandSlug = brandSlugForDropboxPath(pathLower);
      const brandId = brandIdBySlug.get(brandSlug);

      if (!brandId) {
        skipped += 1;
        continue;
      }

      const sourceMetadata = JSON.stringify({
        rev: entry.rev || null,
        serverModified: entry.server_modified || null,
        clientModified: entry.client_modified || null
      });
      const folderHints = folderHintsFromPath(
        entry.path_display || entry.path_lower || "",
        brandSlug || ""
      );

      const existing = await client.query(
        `SELECT "id" FROM "Asset"
         WHERE "brandId" = $1
           AND "sourceType" = 'dropbox'
           AND "sourceFileId" = $2
         LIMIT 1`,
        [brandId, entry.id]
      );

      if (existing.rows[0]) {
        await client.query(
          `UPDATE "Asset"
           SET "storageRootId" = $2,
               "sourcePath" = $3,
               "sourcePathLower" = $4,
               "contentHash" = $5,
               "filename" = $6,
               "fileSizeBytes" = $7,
               "kind" = $8::"AssetKind",
               "sourceMetadata" = $9::jsonb,
               "folderSuggestions" = $10::jsonb,
               "aspectRatioLabel" = COALESCE("aspectRatioLabel", $11),
               "ingestStatus" = CASE WHEN "ingestStatus" = 'raw' THEN 'needs_metadata'::"IngestStatus" ELSE "ingestStatus" END,
               "enrichmentStatus" = CASE WHEN "enrichmentStatus" = 'pending' THEN 'suggested'::"EnrichmentStatus" ELSE "enrichmentStatus" END,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          [
            existing.rows[0].id,
            rootByBrandId.get(brandId) || null,
            entry.path_display || entry.path_lower,
            pathLower,
            entry.content_hash || null,
            entry.name,
            String(entry.size || 0),
            kind,
            sourceMetadata,
            JSON.stringify(folderHints),
            folderHints.aspectRatioLabel
          ]
        );
      } else {
        await client.query(
          `INSERT INTO "Asset"
            ("brandId","storageRootId","sourceType","sourceFileId","sourceMetadata",
             "sourcePath","sourcePathLower","contentHash","filename","fileSizeBytes",
             "kind","folderSuggestions","aspectRatioLabel","ingestStatus","enrichmentStatus","approvalStatus","updatedAt")
           VALUES
            ($1,$2,'dropbox',$3,$4::jsonb,$5,$6,$7,$8,$9,$10::"AssetKind",$11::jsonb,$12,
             'needs_metadata','suggested','approved',CURRENT_TIMESTAMP)`,
          [
            brandId,
            rootByBrandId.get(brandId) || null,
            entry.id,
            sourceMetadata,
            entry.path_display || entry.path_lower,
            pathLower,
            entry.content_hash || null,
            entry.name,
            String(entry.size || 0),
            kind,
            JSON.stringify(folderHints),
            folderHints.aspectRatioLabel
          ]
        );
      }

      indexed += 1;
    }

    await client.query(
      `UPDATE "StorageConnection"
       SET "accountRef" = $2,
           "syncCursor" = $3,
           "lastSyncedAt" = CURRENT_TIMESTAMP,
           "status" = 'active',
           "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1`,
      [
        storageConnectionId,
        event.accountRef || "dropbox",
        event.cursor || null
      ]
    );

    return json(200, {
      ok: true,
      message: "Dropbox metadata page ingested",
      indexed,
      skipped,
      hasMore: Boolean(event.hasMore),
      cursor: event.cursor || null
    });
  } catch (error) {
    console.error("[dropbox-ingest] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Dropbox ingest error"
    });
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

export const handler = async (event = {}) => {
  const requestPath =
    event?.rawPath ||
    event?.requestContext?.http?.path ||
    event?.path ||
    "";

  if (
    event?.action === "ingest-dropbox-page" ||
    requestPath === "/dropbox/ingest-page"
  ) {
    return ingestDropboxPage(event);
  }

  if (event?.action === "backfill-folder-hints") {
    return backfillFolderHints(event);
  }

  if (event?.action === "migrate-asset-commerce-links") {
    let client;
    try {
      client = await connectDatabase();
      await client.query('ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "commerceLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]');
      return json(200, { ok: true, message: "Asset commerce links column is ready" });
    } catch (error) {
      console.error("[asset-commerce-links-migration] failed", error);
      return json(500, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown asset commerce links migration error"
      });
    } finally {
      if (client) {
        try { await client.end(); } catch {}
      }
    }
  }

  if (event?.action === "migrate-asset-tags") {
    let client;
    try {
      client = await connectDatabase();
      await client.query('ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]');
      return json(200, { ok: true, message: "Asset tags column is ready" });
    } catch (error) {
      console.error("[asset-tags-migration] failed", error);
      return json(500, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown asset tags migration error"
      });
    } finally {
      if (client) {
        try { await client.end(); } catch {}
      }
    }
  }



  if (
    event?.action === "bulk-update-assets" ||
    (requestPath === "/assets/bulk-update" && event?.requestContext?.http?.method === "POST")
  ) {
    return bulkUpdateAssets(event);
  }

  return existingHandler(event);
};
