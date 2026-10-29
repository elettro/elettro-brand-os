/**
 * "Connect Mastodon" completion for Elettro OS (one Elettro OS app registered on mastodon.social).
 * The web app trades Mastodon's one-time code and reads the account (this Lambda runs in a VPC
 * without internet egress), then sends both here. This Lambda keeps the access token in Secrets
 * Manager (never in Postgres) and links the account to the brand's Mastodon SocialAccount.
 * Mastodon access tokens do not expire and there is no refresh token, so tokenExpiresAt stays NULL
 * (the token ends only if the owner revokes the app).
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/mastodon/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// "<account id>@<instance>" is unique across the fediverse and safe as a Secrets Manager name.
export function accountKey(instance, id) {
  return `${id}@${instance}`;
}

async function storeAccessToken(key, accessToken, scope, account, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + key;
  const SecretString = JSON.stringify({
    accessToken, scope, instance: account.instance, accountId: account.id, acct: account.acct, brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Mastodon access token for @${account.acct}` }));
  }
}

async function linkSocialAccount(client, brand, key, name) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'mastodon\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [key, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Mastodon account is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this account, then the brand's unlinked Mastodon row.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='mastodon' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, key])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=NULL, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, key, name]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'mastodon',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, name, key]);
  return inserted.rows[0].id;
}

export async function completeMastodonConnect(event, body, connectDatabase, json) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.account || {};
  const accessToken = String(body?.accessToken || "");
  const instance = String(raw.instance || "").toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[0-9]{1,20}$/.test(String(raw.id || "")) ||
      !/^[a-z0-9.-]{3,100}$/.test(instance) || !accessToken) {
    return json(400, { ok: false, error: "brand, account and accessToken are required" });
  }
  const acct = String(raw.acct || raw.id).replace(/^@/, "");
  const account = { id: String(raw.id), instance, acct: acct.includes("@") ? acct : `${acct}@${instance}` };
  const key = accountKey(instance, account.id);
  const name = `@${account.acct}`;
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, key, name);
    await storeAccessToken(key, accessToken, body?.scope || null, account, brand);
    return json(200, { ok: true, brand, socialAccountId, account: { acct: account.acct } });
  } catch (error) {
    console.error("[mastodon-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Mastodon connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
