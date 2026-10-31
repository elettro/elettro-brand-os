/**
 * "Connect TikTok" completion for Elettro OS (TikTok app "Elettro OS" 7698722090002810901, org "Elettro").
 * The web app trades TikTok's one-time code and reads the profile (this Lambda runs in a VPC
 * without internet egress), then sends both here. Access tokens last 24 hours; the refresh
 * token lasts 365 days and each refresh returns a new pair, so the reconnect date shown on
 * Connections is the refresh token's expiry. Tokens go to Secrets Manager (never Postgres).
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";
import { expiresAtFrom } from "./linkedin-connect.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/tiktok/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeTokens(user, tokens, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + user.id;
  const SecretString = JSON.stringify({
    accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken, refreshExpiresAt: tokens.refreshExpiresAt.toISOString(), scope: tokens.scope,
    openId: user.id, username: user.username, brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `TikTok tokens for ${user.handle}` }));
  }
}

async function linkSocialAccount(client, brandId, user, expiresAt) {
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'tiktok\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [user.id, brandId]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That TikTok account is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this account, then the row with the same handle (TikTok can hand the same login a
  // different open_id, e.g. after the app changes; a second row would show twice on Review and plan twice), then the
  // brand's unlinked TikTok row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='tiktok'
      AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL OR lower("accountName")=lower($3))
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, (lower("accountName")=lower($3)) DESC, "createdAt" LIMIT 1`, [brandId, user.id, user.handle])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=$4, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, user.id, user.handle, expiresAt]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","tokenExpiresAt","updatedAt")
     VALUES ($1,'tiktok',$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, user.handle, user.id, expiresAt]);
  return inserted.rows[0].id;
}

export async function completeTiktokConnect(event, body, connectDatabase, json, now = new Date(), store = storeTokens) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.user || {};
  const accessToken = String(body?.accessToken || "");
  const refreshToken = String(body?.refreshToken || "");
  const username = raw.username && /^[A-Za-z0-9._]{1,30}$/.test(String(raw.username)) ? String(raw.username) : null;
  // open_id is an opaque per-app id (letters, digits, "-" and "_"), unlike Meta's numeric ids.
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[A-Za-z0-9_.-]{6,100}$/.test(String(raw.id || "")) || !accessToken || !refreshToken) {
    return json(400, { ok: false, error: "brand, user, accessToken and refreshToken are required" });
  }
  const user = { id: String(raw.id), username, handle: username ? "@" + username : String(raw.name || raw.id).slice(0, 100) };
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
    await store(user, tokens, brand);
    const socialAccountId = await linkSocialAccount(client, brandRow.id, user, tokens.refreshExpiresAt);
    return json(200, { ok: true, brand, socialAccountId, user: { id: user.id, handle: user.handle }, expiresAt: tokens.refreshExpiresAt.toISOString() });
  } catch (error) {
    console.error("[tiktok-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "TikTok connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
