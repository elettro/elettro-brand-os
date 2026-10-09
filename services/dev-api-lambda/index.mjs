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
            sourceMetadata
          ]
        );
      } else {
        await client.query(
          `INSERT INTO "Asset"
            ("brandId","storageRootId","sourceType","sourceFileId","sourceMetadata",
             "sourcePath","sourcePathLower","contentHash","filename","fileSizeBytes",
             "kind","ingestStatus","enrichmentStatus","approvalStatus","updatedAt")
           VALUES
            ($1,$2,'dropbox',$3,$4::jsonb,$5,$6,$7,$8,$9,$10::"AssetKind",
             'raw','pending','approved',CURRENT_TIMESTAMP)`,
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
            kind
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

  return existingHandler(event);
};
