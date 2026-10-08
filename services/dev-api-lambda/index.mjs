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

export const handler = async () => {
  const secretId = process.env.DB_SECRET_NAME;
  const hostOverride = process.env.DB_HOST;

  if (!secretId) {
    return json(500, { ok: false, error: "DB_SECRET_NAME is not configured" });
  }

  let client;

  try {
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

    await client.connect();
    const result = await client.query("SELECT 1 AS ok");

    return json(200, {
      ok: true,
      message: "Authenticated PostgreSQL connection succeeded",
      database,
      result: result.rows[0]
    });
  } catch (error) {
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
