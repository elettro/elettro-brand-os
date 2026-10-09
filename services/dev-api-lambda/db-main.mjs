import { readFileSync } from "node:fs";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";

const { Client } = pg;
const secrets = new SecretsManagerClient({});

const DROPBOX_ROOT = "/1---elettro-brand-os";
const DROPBOX_SECRET_DEFAULT = "elettro-brand-os-dev/dropbox";

const DROPBOX_BRAND_ROOTS = [
  ["solarmeister", "/1---elettro-brand-os/solarmeister"],
  ["stashbox", "/1---elettro-brand-os/stashbox"],
  ["weightlossdavie", "/1---elettro-brand-os/weightlossdavie"],
  ["neckermann-strom", "/1---elettro-brand-os/neckermann-strom"],
  ["therasbox", "/1---elettro-brand-os/therasbox"],
  ["elettro", "/1---elettro-brand-os/elettro"]
];

function assetKindFromName(name = "") {
  const lower = name.toLowerCase();
  if (/\.(mp4|mov|m4v|avi|webm|mkv)$/i.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp|gif|tif|tiff|heic|avif)$/i.test(lower)) return "image";
  return null;
}

async function getJsonSecret(secretId) {
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  if (!response.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }
  return JSON.parse(response.SecretString);
}

async function getDropboxAccessToken(config) {
  if (config.accessToken) return config.accessToken;

  if (!config.appKey || !config.appSecret || !config.refreshToken) {
    throw new Error(
      "Dropbox secret must include accessToken or appKey/appSecret/refreshToken"
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: config.appKey,
    client_secret: config.appSecret
  });

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropbox token refresh failed: ${response.status} ${text}`);
  }

  const token = await response.json();
  return token.access_token;
}

async function dropboxApi(path, token, body) {
  const response = await fetch(`https://api.dropboxapi.com/2/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dropbox API ${path} failed: ${response.status} ${text}`);
  }

  return response.json();
}

function brandSlugForDropboxPath(pathLower = "") {
  const normalized = pathLower.toLowerCase();
  const match = [...DROPBOX_BRAND_ROOTS]
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, root]) => normalized === root || normalized.startsWith(`${root}/`));
  return match?.[0] ?? null;
}


function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

export const handler = async (event = {}) => {
  const secretId = process.env.DB_SECRET_NAME;
  const hostOverride = process.env.DB_HOST;

  if (!secretId) {
    return json(500, { ok: false, error: "DB_SECRET_NAME is not configured" });
  }

  let client;

  try {
    console.log("[health] starting Secrets Manager lookup");
    const response = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId })
    );
    console.log("[health] Secrets Manager lookup succeeded");

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

    console.log("[health] preparing PostgreSQL client");
    client = new Client({
      host,
      port,
      database,
      user,
      password,
      ssl: {
        rejectUnauthorized: false
      },
      connectionTimeoutMillis: 5000,
      query_timeout: 5000
    });

    console.log("[health] starting PostgreSQL connect");
    await client.connect();
    console.log("[health] PostgreSQL connect succeeded");

    const requestPath =
      event?.rawPath ||
      event?.requestContext?.http?.path ||
      event?.path ||
      "";

    const requestAction =
      event?.action ||
      (requestPath === "/brands" ? "brands" : null) ||
      (requestPath === "/dashboard" ? "dashboard" : null) ||
      (requestPath === "/assets" ? "assets" : null) ||
      (requestPath === "/content-pool" ? "content-pool" : null) ||
      (requestPath === "/dropbox/register" ? "register-dropbox" : null) ||
      (requestPath === "/dropbox/sync" ? "dropbox-sync" : null);


    if (requestAction === "register-dropbox") {
      const organization = await client.query(
        'SELECT "id" FROM "Organization" WHERE "slug" = $1 LIMIT 1',
        ["elettro"]
      );
      if (!organization.rows[0]) {
        throw new Error("Elettro organization not found");
      }

      const organizationId = organization.rows[0].id;
      const secretRef = process.env.DROPBOX_SECRET_NAME || DROPBOX_SECRET_DEFAULT;

      let connection = await client.query(
        'SELECT "id" FROM "StorageConnection" WHERE "organizationId" = $1 AND "provider" = $2 LIMIT 1',
        [organizationId, "dropbox"]
      );

      let storageConnectionId = connection.rows[0]?.id;
      if (!storageConnectionId) {
        const created = await client.query(
          `INSERT INTO "StorageConnection"
            ("organizationId","provider","accountRef","secretRef","status","updatedAt")
           VALUES ($1,'dropbox','pending',$2,'pending',CURRENT_TIMESTAMP)
           RETURNING "id"`,
          [organizationId, secretRef]
        );
        storageConnectionId = created.rows[0].id;
      }

      for (const [slug, rootPath] of DROPBOX_BRAND_ROOTS) {
        const brand = await client.query(
          'SELECT "id" FROM "Brand" WHERE "organizationId" = $1 AND "slug" = $2 LIMIT 1',
          [organizationId, slug]
        );
        if (!brand.rows[0]) continue;

        await client.query(
          `INSERT INTO "BrandStorageRoot"
            ("brandId","storageConnectionId","rootPath","rootPathLower","status","updatedAt")
           VALUES ($1,$2,$3,$4,'active',CURRENT_TIMESTAMP)
           ON CONFLICT ("storageConnectionId","rootPathLower")
           DO UPDATE SET "brandId" = EXCLUDED."brandId", "status" = 'active', "updatedAt" = CURRENT_TIMESTAMP`,
          [brand.rows[0].id, storageConnectionId, rootPath, rootPath.toLowerCase()]
        );
      }

      return json(200, {
        ok: true,
        message: "Dropbox connection shell and six brand roots registered",
        storageConnectionId,
        status: "pending"
      });
    }

    if (requestAction === "dropbox-sync") {
      const dropboxSecretId =
        process.env.DROPBOX_SECRET_NAME || DROPBOX_SECRET_DEFAULT;
      console.log("[dropbox] reading Dropbox secret");
      const dropboxConfig = await getJsonSecret(dropboxSecretId);
      const accessToken = await getDropboxAccessToken(dropboxConfig);
      console.log("[dropbox] credentials ready");

      const organization = await client.query(
        'SELECT "id" FROM "Organization" WHERE "slug" = $1 LIMIT 1',
        ["elettro"]
      );
      if (!organization.rows[0]) {
        throw new Error("Elettro organization not found");
      }
      const organizationId = organization.rows[0].id;

      let connection = await client.query(
        'SELECT "id","syncCursor" FROM "StorageConnection" WHERE "organizationId" = $1 AND "provider" = $2 LIMIT 1',
        [organizationId, "dropbox"]
      );

      if (!connection.rows[0]) {
        throw new Error("Dropbox connection is not registered. Run register-dropbox first.");
      }

      const storageConnectionId = connection.rows[0].id;
      const cursor = event?.cursor || connection.rows[0].syncCursor || null;

      const listing = cursor
        ? await dropboxApi("files/list_folder/continue", accessToken, { cursor })
        : await dropboxApi("files/list_folder", accessToken, {
            path: DROPBOX_ROOT,
            recursive: true,
            include_deleted: false,
            include_non_downloadable_files: false,
            limit: 500
          });

      const brandRows = await client.query(
        'SELECT "id","slug" FROM "Brand" WHERE "organizationId" = $1',
        [organizationId]
      );
      const brandIdBySlug = new Map(
        brandRows.rows.map((row) => [row.slug, row.id])
      );

      const rootRows = await client.query(
        'SELECT "id","brandId","rootPathLower" FROM "BrandStorageRoot" WHERE "storageConnectionId" = $1',
        [storageConnectionId]
      );
      const rootByBrandId = new Map(
        rootRows.rows.map((row) => [row.brandId, row])
      );

      let indexed = 0;
      let skipped = 0;

      for (const entry of listing.entries || []) {
        if (entry[".tag"] !== "file") continue;
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

        const root = rootByBrandId.get(brandId);
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
              root?.id ?? null,
              entry.path_display || entry.path_lower,
              pathLower,
              entry.content_hash || null,
              entry.name,
              String(entry.size || 0),
              kind,
              JSON.stringify({
                rev: entry.rev || null,
                serverModified: entry.server_modified || null,
                clientModified: entry.client_modified || null
              })
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
              root?.id ?? null,
              entry.id,
              JSON.stringify({
                rev: entry.rev || null,
                serverModified: entry.server_modified || null,
                clientModified: entry.client_modified || null
              }),
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
          dropboxConfig.accountId || "dropbox",
          listing.cursor || null
        ]
      );

      return json(200, {
        ok: true,
        message: "Dropbox sync page completed",
        indexed,
        skipped,
        hasMore: Boolean(listing.has_more),
        cursor: listing.cursor || null
      });
    }

    if (requestAction === "brands") {
      const result = await client.query(
        'SELECT "id", "name", "slug", "timezone", "status" FROM "Brand" ORDER BY "name"'
      );
      return json(200, { ok: true, brands: result.rows });
    }

    if (requestAction === "dashboard") {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM "Brand" WHERE "status" = 'active') AS "brands",
          (SELECT COUNT(*)::int FROM "StorageConnection" WHERE "status" = 'active') AS "dropboxAccounts",
          (SELECT COUNT(*)::int FROM "Asset") AS "assetsIndexed",
          (
            SELECT COUNT(*)::int
            FROM "Asset"
            WHERE "approvalStatus" = 'approved'
              AND "ingestStatus" = 'ready'
              AND "retiredAt" IS NULL
          ) AS "approvedInPool"
      `);
      return json(200, { ok: true, dashboard: result.rows[0] });
    }

    if (requestAction === "assets") {
      const result = await client.query(`
        SELECT
          a."id",
          a."filename",
          a."kind",
          a."sourceType",
          a."ingestStatus",
          a."approvalStatus",
          a."contentGroup",
          a."topic",
          a."aspectRatioLabel",
          b."slug" AS "brandSlug",
          b."name" AS "brandName"
        FROM "Asset" a
        JOIN "Brand" b ON b."id" = a."brandId"
        ORDER BY a."createdAt" DESC
        LIMIT 100
      `);
      return json(200, { ok: true, assets: result.rows });
    }

    if (requestAction === "content-pool") {
      const result = await client.query(`
        SELECT
          a."id",
          a."filename",
          a."kind",
          a."contentGroup",
          a."topic",
          a."eligibilityType",
          a."priority",
          b."slug" AS "brandSlug",
          b."name" AS "brandName"
        FROM "Asset" a
        JOIN "Brand" b ON b."id" = a."brandId"
        WHERE a."approvalStatus" = 'approved'
          AND a."ingestStatus" = 'ready'
          AND a."retiredAt" IS NULL
        ORDER BY a."updatedAt" DESC
        LIMIT 100
      `);
      return json(200, { ok: true, assets: result.rows });
    }

    if (event?.action === "init-db") {
      console.log("[init] starting schema initialization");
      const initSql = readFileSync(new URL("./init.sql", import.meta.url), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(initSql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      const brandCount = await client.query(
        'SELECT COUNT(*)::int AS count FROM "Brand"'
      );
      console.log("[init] schema initialization succeeded");

      return json(200, {
        ok: true,
        message: "DEV database initialized",
        database,
        brands: brandCount.rows[0]?.count ?? 0
      });
    }

    const result = await client.query("SELECT 1 AS ok");
    console.log("[health] SELECT 1 succeeded");

    return json(200, {
      ok: true,
      message: "Authenticated PostgreSQL connection succeeded",
      database,
      result: result.rows[0]
    });
  } catch (error) {
    console.error("[health] failed:", error instanceof Error ? error.message : error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown database connection error"
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
};
