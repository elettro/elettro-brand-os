import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { handler as existingHandler } from "./db-main.mjs";

const { Client } = pg;
const secrets = new SecretsManagerClient({});
const s3 = new S3Client({});

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


function parseJsonBody(event) {
  let body = event?.body;
  if (typeof body === "string") {
    try { return body ? JSON.parse(body) : {}; } catch { return {}; }
  }
  return body && typeof body === "object" ? body : {};
}

function weekdayNameForYmd(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function addDaysToYmd(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function ymdInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function localDateTimeToUtc(ymd, hhmm, timeZone) {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = String(hhmm || "12:00").split(":").map(Number);
  let utcMillis = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);

  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(new Date(utcMillis));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const rendered = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour === "24" ? "0" : values.hour),
      Number(values.minute),
      0
    );
    const desired = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);
    utcMillis += desired - rendered;
  }

  return new Date(utcMillis);
}

function normalizePreferredDays(days) {
  const aliases = {
    sun: "Sun", sunday: "Sun",
    mon: "Mon", monday: "Mon",
    tue: "Tue", tues: "Tue", tuesday: "Tue",
    wed: "Wed", wednesday: "Wed",
    thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu",
    fri: "Fri", friday: "Fri",
    sat: "Sat", saturday: "Sat"
  };
  return (Array.isArray(days) ? days : [])
    .map((value) => aliases[String(value).trim().toLowerCase()])
    .filter(Boolean);
}

function dateInsideAssetEligibility(asset, slotDate) {
  const ymd = slotDate.toISOString().slice(0, 10);

  if (asset.eligibilityType === "one_time") {
    const from = asset.eligibleFrom ? String(asset.eligibleFrom).slice(0, 10) : null;
    const until = asset.eligibleUntil ? String(asset.eligibleUntil).slice(0, 10) : null;
    if (from && ymd < from) return false;
    if (until && ymd > until) return false;
  }

  if (asset.eligibilityType === "annual") {
    const mmdd = Number(ymd.slice(5, 7) + ymd.slice(8, 10));
    const from = Number(asset.annualFromMmdd || 0);
    const until = Number(asset.annualUntilMmdd || 0);
    if (from && until) {
      if (from <= until) {
        if (mmdd < from || mmdd > until) return false;
      } else if (!(mmdd >= from || mmdd <= until)) {
        return false;
      }
    }
  }

  return true;
}

function destinationAllowed(asset, destination) {
  const allowed = Array.isArray(asset.allowedDestinations) ? asset.allowedDestinations : [];
  const excluded = Array.isArray(asset.excludedDestinations) ? asset.excludedDestinations : [];
  if (excluded.includes(destination)) return false;
  if (allowed.length > 0 && !allowed.includes(destination)) return false;
  return true;
}

function placementCompatible(asset, destination, placement) {
  const p = String(placement || "").toLowerCase();
  const d = String(destination || "").toLowerCase();

  if ((p.includes("short") || p.includes("reel")) && asset.kind !== "video") return false;
  if (d === "youtube" && p.includes("short") && asset.kind !== "video") return false;

  return true;
}

function priorityScore(priority) {
  if (priority === "hero") return 40;
  if (priority === "high") return 25;
  if (priority === "low") return 0;
  return 10;
}

function daysBetween(later, earlier) {
  return Math.max(0, (later.getTime() - earlier.getTime()) / 86400000);
}

async function runPlannerV1(event) {
  let client;
  try {
    client = await connectDatabase();
    const body = parseJsonBody(event);
    const brandSlug = String(body.brandSlug || event?.brandSlug || "").trim();
    const horizonDays = Math.min(Math.max(Number(body.horizonDays || event?.horizonDays || 14), 1), 30);

    if (!brandSlug) {
      return json(400, { ok: false, error: "brandSlug is required" });
    }

    const brandResult = await client.query(
      'SELECT "id","slug","name","timezone" FROM "Brand" WHERE "slug" = $1 AND "status" = $2 LIMIT 1',
      [brandSlug, "active"]
    );
    const brand = brandResult.rows[0];
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });

    const rulesResult = await client.query(
      `SELECT
         cr."id" AS "cadenceRuleId",
         cr."placement",
         cr."postsPerWeek",
         cr."preferredDays",
         cr."preferredStartTime",
         cr."preferredEndTime",
         sa."id" AS "socialAccountId",
         sa."destination",
         sa."accountName",
         sa."publishingMode",
         sa."timezone"
       FROM "CadenceRule" cr
       JOIN "SocialAccount" sa ON sa."id" = cr."socialAccountId"
       WHERE sa."brandId" = $1
         AND sa."status" = 'active'
         AND cr."active" = TRUE
         AND cr."postsPerWeek" > 0
       ORDER BY sa."destination", cr."placement"`,
      [brand.id]
    );

    if (!rulesResult.rowCount) {
      return json(200, {
        ok: true,
        brand: brand.slug,
        horizonDays,
        planned: 0,
        skippedExisting: 0,
        gaps: [],
        message: "No active cadence rules are configured for this brand"
      });
    }

    const assetsResult = await client.query(
      `SELECT
         a."id",
         a."filename",
         a."kind",
         a."sourcePath",
         a."sourceUrl",
         a."approvalStatus",
         a."ingestStatus",
         a."retiredAt",
         a."eligibilityType",
         a."eligibleFrom",
         a."eligibleUntil",
         a."annualFromMmdd",
         a."annualUntilMmdd",
         a."priority",
         a."allowedDestinations",
         a."excludedDestinations",
         a."creativeFamily",
         a."contentGroup",
         a."topic",
         a."campaignId",
         a."shopifyProductId"
       FROM "Asset" a
       WHERE a."brandId" = $1
         AND a."approvalStatus" = 'approved'
         AND a."ingestStatus" = 'ready'
         AND a."retiredAt" IS NULL
         AND (a."sourcePath" IS NOT NULL OR a."sourceUrl" IS NOT NULL)`,
      [brand.id]
    );

    const startYmd = ymdInTimeZone(new Date(), brand.timezone || "America/New_York");
    const horizonEnd = localDateTimeToUtc(addDaysToYmd(startYmd, horizonDays), "00:00", brand.timezone || "America/New_York");

    const historyResult = await client.query(
      `SELECT
         pl."socialAccountId",
         pl."assetId",
         pl."publishedAt",
         pl."creativeFamilySnapshot",
         pl."campaignSnapshot",
         a."shopifyProductId"
       FROM "PublicationLedger" pl
       LEFT JOIN "Asset" a ON a."id" = pl."assetId"
       WHERE pl."brandId" = $1
         AND pl."publishedAt" >= CURRENT_TIMESTAMP - INTERVAL '90 days'
       ORDER BY pl."publishedAt" DESC`,
      [brand.id]
    );

    const plannedExistingResult = await client.query(
      `SELECT
         sp."id",
         sp."socialAccountId",
         sp."assetId",
         sp."placement",
         sp."scheduledFor",
         a."creativeFamily",
         a."campaignId",
         a."shopifyProductId"
       FROM "ScheduledPost" sp
       JOIN "Asset" a ON a."id" = sp."assetId"
       WHERE sp."brandId" = $1
         AND sp."scheduledFor" >= CURRENT_TIMESTAMP
         AND sp."scheduledFor" < $2
         AND sp."status" IN ('planned','approved','queued')`,
      [brand.id, horizonEnd]
    );

    const plannedInRun = [];
    const gaps = [];
    let planned = 0;
    let skippedExisting = 0;

    for (const rule of rulesResult.rows) {
      const accountTimeZone = rule.timezone || brand.timezone || "America/New_York";
      const preferredDays = normalizePreferredDays(rule.preferredDays);
      const eligibleDays = [];

      for (let offset = 0; offset < horizonDays; offset += 1) {
        const ymd = addDaysToYmd(startYmd, offset);
        const weekday = weekdayNameForYmd(ymd);
        if (preferredDays.length && !preferredDays.includes(weekday)) continue;
        eligibleDays.push(ymd);
      }

      const targetSlots = Math.max(1, Math.round(Number(rule.postsPerWeek) * horizonDays / 7));
      const chosenDays = [];
      if (eligibleDays.length <= targetSlots) {
        chosenDays.push(...eligibleDays);
      } else {
        for (let i = 0; i < targetSlots; i += 1) {
          const index = Math.min(
            eligibleDays.length - 1,
            Math.round(i * (eligibleDays.length - 1) / Math.max(targetSlots - 1, 1))
          );
          if (!chosenDays.includes(eligibleDays[index])) chosenDays.push(eligibleDays[index]);
        }
      }

      for (const ymd of chosenDays) {
        const scheduledFor = localDateTimeToUtc(
          ymd,
          rule.preferredStartTime || "12:00",
          accountTimeZone
        );

        if (scheduledFor.getTime() <= Date.now()) continue;

        const existingSlot = plannedExistingResult.rows.find((post) =>
          post.socialAccountId === rule.socialAccountId &&
          String(post.placement).toLowerCase() === String(rule.placement).toLowerCase() &&
          Math.abs(new Date(post.scheduledFor).getTime() - scheduledFor.getTime()) < 30 * 60000
        );

        if (existingSlot) {
          skippedExisting += 1;
          continue;
        }

        const sameAccountLedger = historyResult.rows.filter(
          (entry) => entry.socialAccountId === rule.socialAccountId
        );
        const sameAccountPlanned = [
          ...plannedExistingResult.rows.filter((entry) => entry.socialAccountId === rule.socialAccountId),
          ...plannedInRun.filter((entry) => entry.socialAccountId === rule.socialAccountId)
        ];

        const candidates = [];

        for (const asset of assetsResult.rows) {
          if (!dateInsideAssetEligibility(asset, scheduledFor)) continue;
          if (!destinationAllowed(asset, rule.destination)) continue;
          if (!placementCompatible(asset, rule.destination, rule.placement)) continue;

          const ledgerUses = sameAccountLedger.filter((entry) => entry.assetId === asset.id);
          const plannedUses = sameAccountPlanned.filter((entry) => entry.assetId === asset.id);

          const recentExactLedger = ledgerUses.some(
            (entry) => daysBetween(scheduledFor, new Date(entry.publishedAt)) < 45
          );
          const recentExactPlanned = plannedUses.some(
            (entry) => Math.abs(daysBetween(scheduledFor, new Date(entry.scheduledFor))) < 45
          );
          if (recentExactLedger || recentExactPlanned) continue;

          if (asset.creativeFamily) {
            const recentFamilyLedger = sameAccountLedger.some((entry) =>
              entry.creativeFamilySnapshot === asset.creativeFamily &&
              daysBetween(scheduledFor, new Date(entry.publishedAt)) < 21
            );
            const recentFamilyPlanned = sameAccountPlanned.some((entry) =>
              entry.creativeFamily === asset.creativeFamily &&
              Math.abs(daysBetween(scheduledFor, new Date(entry.scheduledFor))) < 21
            );
            if (recentFamilyLedger || recentFamilyPlanned) continue;
          }

          if (asset.shopifyProductId) {
            const recentProductLedger = sameAccountLedger.some((entry) =>
              entry.shopifyProductId === asset.shopifyProductId &&
              daysBetween(scheduledFor, new Date(entry.publishedAt)) < 5
            );
            const recentProductPlanned = sameAccountPlanned.some((entry) =>
              entry.shopifyProductId === asset.shopifyProductId &&
              Math.abs(daysBetween(scheduledFor, new Date(entry.scheduledFor))) < 5
            );
            if (recentProductLedger || recentProductPlanned) continue;
          }

          if (asset.campaignId && sameAccountPlanned.length) {
            const prior = [...sameAccountPlanned]
              .filter((entry) => new Date(entry.scheduledFor).getTime() < scheduledFor.getTime())
              .sort((a, b) => new Date(b.scheduledFor) - new Date(a.scheduledFor))[0];
            if (prior?.campaignId === asset.campaignId) continue;
          }

          const lastUse = ledgerUses[0]?.publishedAt ? new Date(ledgerUses[0].publishedAt) : null;
          const lastUseScore = lastUse
            ? Math.min(60, daysBetween(scheduledFor, lastUse))
            : 60;
          const priority = priorityScore(asset.priority);
          const selectedSameGroup = plannedInRun.filter(
            (entry) => entry.socialAccountId === rule.socialAccountId &&
              entry.contentGroup &&
              entry.contentGroup === asset.contentGroup
          ).length;
          const balance = Math.max(0, 15 - selectedSameGroup * 5);
          const seasonal = asset.eligibilityType === "annual" ? 5 : 0;
          const total = lastUseScore + priority + balance + seasonal;

          candidates.push({
            asset,
            score: total,
            breakdown: {
              lastUse: Number(lastUseScore.toFixed(2)),
              priority,
              contentBalance: balance,
              seasonal
            },
            lastUsedAt: lastUse ? lastUse.toISOString() : null
          });
        }

        candidates.sort((a, b) =>
          b.score - a.score ||
          String(a.asset.filename).localeCompare(String(b.asset.filename))
        );

        const winner = candidates[0];

        if (!winner) {
          gaps.push({
            socialAccountId: rule.socialAccountId,
            destination: rule.destination,
            placement: rule.placement,
            scheduledFor: scheduledFor.toISOString(),
            reason: "No asset passed hard filters and cooldowns"
          });
          continue;
        }

        const reason =
          `Selected \${winner.asset.filename} with score \${winner.score.toFixed(2)}. ` +
          `Last use: \${winner.lastUsedAt || "never"}; priority: \${winner.asset.priority || "normal"}.`;

        const inserted = await client.query(
          `INSERT INTO "ScheduledPost"
            ("brandId","socialAccountId","assetId","placement","scheduledFor","status",
             "selectionReason","scoreBreakdown","publishingMode","updatedAt")
           VALUES ($1,$2,$3,$4,$5,'planned',$6,$7::jsonb,$8,CURRENT_TIMESTAMP)
           RETURNING "id","scheduledFor"`,
          [
            brand.id,
            rule.socialAccountId,
            winner.asset.id,
            rule.placement,
            scheduledFor,
            reason,
            JSON.stringify(winner.breakdown),
            rule.publishingMode || "handoff"
          ]
        );

        planned += 1;
        plannedInRun.push({
          id: inserted.rows[0].id,
          socialAccountId: rule.socialAccountId,
          assetId: winner.asset.id,
          placement: rule.placement,
          scheduledFor: inserted.rows[0].scheduledFor,
          creativeFamily: winner.asset.creativeFamily,
          campaignId: winner.asset.campaignId,
          shopifyProductId: winner.asset.shopifyProductId,
          contentGroup: winner.asset.contentGroup
        });
      }
    }

    return json(200, {
      ok: true,
      brand: brand.slug,
      horizonDays,
      rules: rulesResult.rowCount,
      eligibleAssets: assetsResult.rowCount,
      planned,
      skippedExisting,
      gaps,
      message: "Planner V1 run completed"
    });
  } catch (error) {
    console.error("[planner-v1] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown planner error"
    });
  } finally {
    if (client) {
      try { await client.end(); } catch {}
    }
  }
}


async function configurePlannerAccount(event) {
  let client;
  try {
    client = await connectDatabase();
    const body = parseJsonBody(event);

    const brandSlug = String(body.brandSlug || event?.brandSlug || "").trim();
    const destination = String(body.destination || event?.destination || "").trim().toLowerCase();
    const accountName = String(body.accountName || event?.accountName || "").trim();
    const placement = String(body.placement || event?.placement || "").trim();
    const publishingMode = String(body.publishingMode || event?.publishingMode || "handoff").trim();
    const postsPerWeek = Math.max(0, Number(body.postsPerWeek ?? event?.postsPerWeek ?? 3));
    const preferredDays = Array.isArray(body.preferredDays || event?.preferredDays)
      ? (body.preferredDays || event.preferredDays)
      : [];
    const preferredStartTime = String(body.preferredStartTime || event?.preferredStartTime || "12:00").trim();

    if (!brandSlug || !destination || !accountName || !placement) {
      return json(400, {
        ok: false,
        error: "brandSlug, destination, accountName, and placement are required"
      });
    }

    const brandResult = await client.query(
      'SELECT "id","timezone" FROM "Brand" WHERE "slug" = $1 AND "status" = $2 LIMIT 1',
      [brandSlug, "active"]
    );
    const brand = brandResult.rows[0];
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });

    await client.query("BEGIN");
    try {
      let accountResult = await client.query(
        `SELECT "id" FROM "SocialAccount"
         WHERE "brandId" = $1 AND "destination" = $2 AND "accountName" = $3
         LIMIT 1`,
        [brand.id, destination, accountName]
      );

      let socialAccountId = accountResult.rows[0]?.id;

      if (!socialAccountId) {
        accountResult = await client.query(
          `INSERT INTO "SocialAccount"
            ("brandId","destination","accountName","publishingMode","timezone","status","updatedAt")
           VALUES ($1,$2,$3,$4,$5,'active',CURRENT_TIMESTAMP)
           RETURNING "id"`,
          [brand.id, destination, accountName, publishingMode, brand.timezone || "America/New_York"]
        );
        socialAccountId = accountResult.rows[0].id;
      } else {
        await client.query(
          `UPDATE "SocialAccount"
           SET "publishingMode" = $2,
               "timezone" = $3,
               "status" = 'active',
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          [socialAccountId, publishingMode, brand.timezone || "America/New_York"]
        );
      }

      let cadenceResult = await client.query(
        `SELECT "id" FROM "CadenceRule"
         WHERE "socialAccountId" = $1 AND "placement" = $2
         LIMIT 1`,
        [socialAccountId, placement]
      );

      let cadenceRuleId = cadenceResult.rows[0]?.id;

      if (!cadenceRuleId) {
        cadenceResult = await client.query(
          `INSERT INTO "CadenceRule"
            ("socialAccountId","placement","postsPerWeek","preferredDays","preferredStartTime","active","updatedAt")
           VALUES ($1,$2,$3,$4,$5,TRUE,CURRENT_TIMESTAMP)
           RETURNING "id"`,
          [socialAccountId, placement, postsPerWeek, preferredDays, preferredStartTime]
        );
        cadenceRuleId = cadenceResult.rows[0].id;
      } else {
        await client.query(
          `UPDATE "CadenceRule"
           SET "postsPerWeek" = $2,
               "preferredDays" = $3,
               "preferredStartTime" = $4,
               "active" = TRUE,
               "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1`,
          [cadenceRuleId, postsPerWeek, preferredDays, preferredStartTime]
        );
      }

      await client.query("COMMIT");

      return json(200, {
        ok: true,
        message: "Planner social account and cadence rule are ready",
        brandSlug,
        socialAccountId,
        cadenceRuleId,
        destination,
        accountName,
        placement,
        publishingMode,
        postsPerWeek,
        preferredDays,
        preferredStartTime
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("[planner-account-config] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown planner account configuration error"
    });
  } finally {
    if (client) {
      try { await client.end(); } catch {}
    }
  }
}


function safeUploadFilename(name = "asset") {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180) || "asset";
}

function slugifyName(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function uploadDestinationNames(values) {
  const map = {
    instagram: "instagram",
    facebook: "facebook",
    tiktok: "tiktok",
    youtube: "youtube",
    linkedin: "linkedin",
    x: "x",
    website: "website",
    rss: "rss"
  };
  return (Array.isArray(values) ? values : [])
    .map((value) => map[String(value).trim().toLowerCase()])
    .filter(Boolean);
}

function mmddFromDateString(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  return Number(String(value).slice(5, 7) + String(value).slice(8, 10));
}

async function presignDirectUploads(event) {
  try {
    const bucket = process.env.ASSET_UPLOAD_BUCKET;
    if (!bucket) {
      return json(500, { ok: false, error: "ASSET_UPLOAD_BUCKET is not configured" });
    }

    const body = parseJsonBody(event);
    const brandSlug = String(body.brandSlug || "").trim().toLowerCase();
    const files = Array.isArray(body.files) ? body.files : [];

    if (!brandSlug || !files.length) {
      return json(400, { ok: false, error: "brandSlug and files are required" });
    }

    if (files.length > 100) {
      return json(400, { ok: false, error: "Maximum 100 files per intake batch" });
    }

    const datePrefix = new Date().toISOString().slice(0, 10);
    const uploads = [];

    for (const file of files) {
      const name = safeUploadFilename(file?.name);
      const contentType = String(file?.type || "application/octet-stream");
      const size = Number(file?.size || 0);

      if (!name || !size) {
        return json(400, { ok: false, error: "Each file requires name and size" });
      }

      const key = `direct/${brandSlug}/${datePrefix}/${randomUUID()}-${name}`;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Metadata: {
          "brand-slug": brandSlug,
          "original-name": name
        }
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
      uploads.push({ key, uploadUrl, contentType, size, name: file.name });
    }

    return json(200, {
      ok: true,
      bucket,
      expiresInSeconds: 900,
      uploads
    });
  } catch (error) {
    console.error("[direct-upload-presign] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown direct upload presign error"
    });
  }
}

async function completeDirectUploads(event) {
  let client;
  try {
    const bucket = process.env.ASSET_UPLOAD_BUCKET;
    if (!bucket) {
      return json(500, { ok: false, error: "ASSET_UPLOAD_BUCKET is not configured" });
    }

    const body = parseJsonBody(event);
    const brandSlug = String(body.brandSlug || "").trim().toLowerCase();
    const files = Array.isArray(body.files) ? body.files : [];
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    const mode = body.mode === "raw" ? "raw" : "ready";

    if (!brandSlug || !files.length) {
      return json(400, { ok: false, error: "brandSlug and files are required" });
    }

    client = await connectDatabase();

    const brandResult = await client.query(
      'SELECT "id" FROM "Brand" WHERE "slug" = $1 AND "status" = $2 LIMIT 1',
      [brandSlug, "active"]
    );
    const brandId = brandResult.rows[0]?.id;
    if (!brandId) return json(404, { ok: false, error: "Active brand not found" });

    let collectionId = null;
    if (String(metadata.collection || "").trim()) {
      const name = String(metadata.collection).trim();
      const slug = slugifyName(name);
      const result = await client.query(
        `INSERT INTO "Collection" ("brandId","name","slug","updatedAt")
         VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
         ON CONFLICT ("brandId","slug")
         DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP
         RETURNING "id"`,
        [brandId, name, slug]
      );
      collectionId = result.rows[0]?.id || null;
    }

    let campaignId = null;
    if (String(metadata.campaign || "").trim()) {
      const name = String(metadata.campaign).trim();
      const slug = slugifyName(name);
      const result = await client.query(
        `INSERT INTO "Campaign" ("brandId","name","slug","updatedAt")
         VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
         ON CONFLICT ("brandId","slug")
         DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP
         RETURNING "id"`,
        [brandId, name, slug]
      );
      campaignId = result.rows[0]?.id || null;
    }

    const allowedDestinations = uploadDestinationNames(metadata.allowedDestinations);
    const approvalStatus = metadata.sendToApprovalQueue ? "needs_review" : "approved";
    const eligibilityMode = metadata.eligibilityMode === "window" ? "window" : "evergreen";
    const repeatAnnually = Boolean(metadata.repeatAnnually);

    let eligibilityType = "evergreen";
    let eligibleFrom = null;
    let eligibleUntil = null;
    let annualFromMmdd = null;
    let annualUntilMmdd = null;

    if (eligibilityMode === "window" && repeatAnnually) {
      eligibilityType = "annual";
      annualFromMmdd = mmddFromDateString(metadata.windowStart);
      annualUntilMmdd = mmddFromDateString(metadata.windowEnd);
    } else if (eligibilityMode === "window") {
      eligibilityType = "one_time";
      eligibleFrom = metadata.windowStart || null;
      eligibleUntil = metadata.windowEnd || null;
    }

    const inserted = [];

    for (const file of files) {
      const key = String(file?.key || "");
      const filename = String(file?.name || "").trim();
      const contentType = String(file?.type || "application/octet-stream");
      const size = Number(file?.size || 0);
      const kind = assetKindFromName(filename);

      if (!key.startsWith(`direct/${brandSlug}/`) || !filename || !kind) {
        return json(400, { ok: false, error: `Invalid completed upload: ${filename || key}` });
      }

      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      const sourceMetadata = JSON.stringify({
        bucket,
        key,
        contentType,
        directUpload: true
      });

      const result = await client.query(
        `INSERT INTO "Asset" (
           "brandId","collectionId","campaignId","sourceType","sourceExternalId","sourceUrl","sourceMetadata",
           "filename","mimeType","fileSizeBytes","kind","ingestStatus","enrichmentStatus","approvalStatus",
           "topic","creativeFamily","creatorNote","priority","eligibilityType","eligibleFrom","eligibleUntil",
           "annualFromMmdd","annualUntilMmdd","allowedDestinations","firstApprovedAt","updatedAt"
         )
         VALUES (
           $1,$2,$3,'direct_upload',$4,$5,$6::jsonb,
           $7,$8,$9,$10::"AssetKind",$11::"IngestStatus",$12::"EnrichmentStatus",$13::"ApprovalStatus",
           $14,$15,$16,$17,$18::"EligibilityType",$19::date,$20::date,
           $21,$22,$23,
           CASE WHEN $13 = 'approved' AND $11 = 'ready' THEN CURRENT_TIMESTAMP ELSE NULL END,
           CURRENT_TIMESTAMP
         )
         ON CONFLICT DO NOTHING
         RETURNING "id","filename","ingestStatus","approvalStatus"`,
        [
          brandId,
          collectionId,
          campaignId,
          key,
          `s3://${bucket}/${key}`,
          sourceMetadata,
          filename,
          contentType,
          String(size),
          kind,
          mode === "raw" ? "raw" : "ready",
          mode === "raw" ? "pending" : "reviewed",
          approvalStatus,
          String(metadata.topic || "").trim() || null,
          String(metadata.creativeFamily || "").trim() || null,
          String(metadata.creatorNote || "").trim() || null,
          String(metadata.priority || "normal"),
          eligibilityType,
          eligibleFrom,
          eligibleUntil,
          annualFromMmdd,
          annualUntilMmdd,
          allowedDestinations
        ]
      );

      if (result.rows[0]) inserted.push(result.rows[0]);
    }

    return json(200, {
      ok: true,
      created: inserted.length,
      mode,
      assets: inserted,
      message: mode === "raw"
        ? "Direct uploads saved as raw assets"
        : "Direct uploads ingested and marked ready"
    });
  } catch (error) {
    console.error("[direct-upload-complete] failed", error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown direct upload completion error"
    });
  } finally {
    if (client) {
      try { await client.end(); } catch {}
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

  if (event?.action === "migrate-publication-foundation") {
    let client;
    try {
      client = await connectDatabase();
      await client.query("BEGIN");
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

        await client.query(`
          CREATE TABLE IF NOT EXISTS "SocialAccount" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
            "destination" TEXT NOT NULL,
            "accountName" TEXT NOT NULL,
            "externalAccountId" TEXT,
            "publishingMode" TEXT NOT NULL DEFAULT 'handoff',
            "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
            "status" TEXT NOT NULL DEFAULT 'active',
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS "SocialAccount_brandId_destination_status_idx" ON "SocialAccount"("brandId","destination","status")');

        await client.query(`
          CREATE TABLE IF NOT EXISTS "CadenceRule" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "socialAccountId" UUID NOT NULL REFERENCES "SocialAccount"("id") ON DELETE CASCADE,
            "placement" TEXT NOT NULL,
            "postsPerWeek" INTEGER NOT NULL DEFAULT 0,
            "preferredDays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            "preferredStartTime" TEXT,
            "preferredEndTime" TEXT,
            "active" BOOLEAN NOT NULL DEFAULT TRUE,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS "CadenceRule_socialAccountId_active_idx" ON "CadenceRule"("socialAccountId","active")');

        await client.query(`
          CREATE TABLE IF NOT EXISTS "ScheduledPost" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
            "socialAccountId" UUID NOT NULL REFERENCES "SocialAccount"("id") ON DELETE CASCADE,
            "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE CASCADE,
            "placement" TEXT NOT NULL,
            "scheduledFor" TIMESTAMP(3) NOT NULL,
            "status" TEXT NOT NULL DEFAULT 'planned',
            "generatedTitle" TEXT,
            "generatedCaption" TEXT,
            "generatedHashtags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            "selectionReason" TEXT,
            "scoreBreakdown" JSONB NOT NULL DEFAULT '{}'::JSONB,
            "publishingMode" TEXT NOT NULL DEFAULT 'handoff',
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS "ScheduledPost_brandId_scheduledFor_status_idx" ON "ScheduledPost"("brandId","scheduledFor","status")');
        await client.query('CREATE INDEX IF NOT EXISTS "ScheduledPost_socialAccountId_scheduledFor_idx" ON "ScheduledPost"("socialAccountId","scheduledFor")');
        await client.query('CREATE INDEX IF NOT EXISTS "ScheduledPost_assetId_scheduledFor_idx" ON "ScheduledPost"("assetId","scheduledFor")');

        await client.query(`
          CREATE TABLE IF NOT EXISTS "PublicationLedger" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
            "socialAccountId" UUID NOT NULL REFERENCES "SocialAccount"("id") ON DELETE CASCADE,
            "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT,
            "scheduledPostId" UUID REFERENCES "ScheduledPost"("id") ON DELETE SET NULL,
            "destination" TEXT NOT NULL,
            "placement" TEXT NOT NULL,
            "publishedAt" TIMESTAMP(3) NOT NULL,
            "method" TEXT NOT NULL,
            "externalPostId" TEXT,
            "externalUrl" TEXT,
            "assetFilenameSnapshot" TEXT NOT NULL,
            "contentGroupSnapshot" TEXT,
            "creativeFamilySnapshot" TEXT,
            "campaignSnapshot" TEXT,
            "topicSnapshot" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS "PublicationLedger_assetId_publishedAt_idx" ON "PublicationLedger"("assetId","publishedAt")');
        await client.query('CREATE INDEX IF NOT EXISTS "PublicationLedger_brandId_publishedAt_idx" ON "PublicationLedger"("brandId","publishedAt")');
        await client.query('CREATE INDEX IF NOT EXISTS "PublicationLedger_socialAccountId_publishedAt_idx" ON "PublicationLedger"("socialAccountId","publishedAt")');
        await client.query('CREATE INDEX IF NOT EXISTS "PublicationLedger_destination_publishedAt_idx" ON "PublicationLedger"("destination","publishedAt")');

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      return json(200, {
        ok: true,
        message: "Publication history foundation is ready",
        tables: ["SocialAccount", "CadenceRule", "ScheduledPost", "PublicationLedger"]
      });
    } catch (error) {
      console.error("[publication-foundation-migration] failed", error);
      return json(500, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown publication foundation migration error"
      });
    } finally {
      if (client) {
        try { await client.end(); } catch {}
      }
    }
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
    event?.action === "direct-upload-presign" ||
    (requestPath === "/assets/upload/presign" && event?.requestContext?.http?.method === "POST")
  ) {
    return presignDirectUploads(event);
  }

  if (
    event?.action === "direct-upload-complete" ||
    (requestPath === "/assets/upload/complete" && event?.requestContext?.http?.method === "POST")
  ) {
    return completeDirectUploads(event);
  }

  if (event?.action === "configure-planner-account") {
    return configurePlannerAccount(event);
  }

  if (
    event?.action === "run-planner-v1" ||
    (requestPath === "/planner/run" && event?.requestContext?.http?.method === "POST")
  ) {
    return runPlannerV1(event);
  }

  if (
    event?.action === "bulk-update-assets" ||
    (requestPath === "/assets/bulk-update" && event?.requestContext?.http?.method === "POST")
  ) {
    return bulkUpdateAssets(event);
  }

  return existingHandler(event);
};
