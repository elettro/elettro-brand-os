/**
 * "Connect Pinterest" completion for Elettro OS (Pinterest app "Elettro OS" 1627333, account pinterest.com/elettro).
 * The web app trades Pinterest's one-time code and reads the account (this Lambda runs in a VPC
 * without internet egress), then sends both here. Access tokens last 30 days; with continuous
 * refresh each refresh also extends the refresh token, so the reconnect date shown on Connections
 * is the refresh token's expiry. Tokens go to Secrets Manager (never Postgres).
 * One Pinterest account may serve several brands (pinterest.com/elettro pins Stashbox content to a
 * Stashbox board): each brand gets its own pinterest SocialAccount row, sharing one token secret
 * whose "brands" lists every brand connected to it.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";
import { expiresAtFrom } from "./linkedin-connect.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/pinterest/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeTokens(user, tokens, brand, brands) {
  const SecretId = TOKEN_SECRET_PREFIX + user.id;
  const SecretString = JSON.stringify({
    accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken, refreshExpiresAt: tokens.refreshExpiresAt.toISOString(), scope: tokens.scope,
    userId: user.id, username: user.username, brand, brands, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Pinterest tokens for ${user.handle}` }));
  }
}

async function linkSocialAccount(client, brandId, user, expiresAt) {
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this account, then the brand's unlinked Pinterest row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='pinterest' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandId, user.id])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=$4, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, user.id, user.handle, expiresAt]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","tokenExpiresAt","updatedAt")
     VALUES ($1,'pinterest',$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, user.handle, user.id, expiresAt]);
  return inserted.rows[0].id;
}

export async function completePinterestConnect(event, body, connectDatabase, json, now = new Date(), store = storeTokens) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.user || {};
  const accessToken = String(body?.accessToken || "");
  const refreshToken = String(body?.refreshToken || "");
  const username = raw.username && /^[A-Za-z0-9_]{1,30}$/.test(String(raw.username)) ? String(raw.username) : null;
  // Pinterest account ids are numeric; the web app falls back to the username when none is returned.
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[A-Za-z0-9_]{3,40}$/.test(String(raw.id || "")) || !accessToken || !refreshToken) {
    return json(400, { ok: false, error: "brand, user, accessToken and refreshToken are required" });
  }
  const user = { id: String(raw.id), username, handle: username ? "@" + username : String(raw.name || raw.id).slice(0, 100) };
  // Brands already sharing this account's token (read by the web app from the existing secret) plus this one.
  const brands = [...new Set([...(Array.isArray(body?.brands) ? body.brands : []).map(String), brand])].filter((b) => /^[a-z0-9-]{2,40}$/.test(b));
  const tokens = {
    accessToken, refreshToken, scope: String(body?.scope || ""),
    accessExpiresAt: expiresAtFrom(body?.expiresIn, now),
    refreshExpiresAt: expiresAtFrom(body?.refreshExpiresIn, now)
  };
  let client;
  try {
    client = await connectDatabase();
    const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
    if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
    // Tokens first: a row that says "connected" must always have tokens behind it.
    await store(user, tokens, brand, brands);
    const socialAccountId = await linkSocialAccount(client, brandRow.id, user, tokens.refreshExpiresAt);
    // The other brands on this account use the same new token, so their reconnect date moves too.
    await client.query(
      'UPDATE "SocialAccount" SET "tokenExpiresAt"=$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "destination"=\'pinterest\' AND "externalAccountId"=$1 AND "id"<>$3',
      [user.id, tokens.refreshExpiresAt, socialAccountId]);
    return json(200, { ok: true, brand, socialAccountId, user: { id: user.id, handle: user.handle }, expiresAt: tokens.refreshExpiresAt.toISOString() });
  } catch (error) {
    console.error("[pinterest-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Pinterest connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
