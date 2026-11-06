/**
 * "Connect Reddit" completion for Elettro OS (one Elettro OS web app in Reddit's app registry, OAuth 2.0 authorization
 * code with duration=permanent). The web app trades Reddit's one-time code and reads the account (this Lambda runs in a
 * VPC without internet egress), then sends both here. This Lambda keeps the tokens in Secrets Manager (never in Postgres)
 * and links the account to the brand's Reddit SocialAccount. Access tokens last 1 hour; the refresh token does not rotate
 * and does not expire until the user revokes the app, so tokenExpiresAt stays NULL.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/reddit/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeTokens(tokens, scope, account, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + account.id;
  const SecretString = JSON.stringify({
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || null, expiresAt: tokens.expiresAt || null,
    scope, accountId: account.id, username: account.username, brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Reddit tokens for u/${account.username}` }));
  }
}

async function linkSocialAccount(client, brand, accountId, name) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'x\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [accountId, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Reddit account is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this account, then the brand's unlinked X row.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='reddit' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, accountId])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=NULL, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, accountId, name]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'reddit',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, name, accountId]);
  return inserted.rows[0].id;
}

export async function completeRedditConnect(event, body, connectDatabase, json) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.account || {};
  const accessToken = String(body?.accessToken || "");
  const username = String(raw.username || "").replace(/^@/, "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[a-z0-9]{1,20}$/.test(String(raw.id || "")) ||
      !/^[A-Za-z0-9_-]{3,20}$/.test(username) || !accessToken) {
    return json(400, { ok: false, error: "brand, account and accessToken are required" });
  }
  const account = { id: String(raw.id), username };
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, account.id, `u/${username}`);
    const refreshToken = body?.refreshToken ? String(body.refreshToken) : null;
    const expiresAt = Number.isFinite(Date.parse(body?.expiresAt)) ? new Date(body.expiresAt).toISOString() : null;
    await storeTokens({ accessToken, refreshToken, expiresAt }, body?.scope || null, account, brand);
    return json(200, { ok: true, brand, socialAccountId, account: { username } });
  } catch (error) {
    console.error("[reddit-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Reddit connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
