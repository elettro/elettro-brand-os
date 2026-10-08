import { readFileSync } from "node:fs";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from "pg";

const { Client } = pg;
const secrets = new SecretsManagerClient({});

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
      (requestPath === "/content-pool" ? "content-pool" : null);

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
