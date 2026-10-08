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
