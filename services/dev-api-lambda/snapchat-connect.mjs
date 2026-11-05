/**
 * "Connect Snapchat" completion for Elettro OS (Snap Public Profile API, allowlisted OAuth app).
 * The web app trades Snap's one-time code for tokens and reads the brand's Public Profile
 * (GET /v1/public_profiles/my_profile) because this Lambda runs in a VPC without internet egress; it then sends the
 * result here. The tokens go to Secrets Manager (never Postgres) under elettro-brand-os-dev/snapchat/<profileId>,
 * and the profile links to the brand's snapchat SocialAccount (externalAccountId = the profile id, a UUID).
 * Snap access tokens last 30 minutes and are renewed by the worker (services/snapchat-lambda) with the refresh token.
 * Snap does not document a refresh-token lifetime, so no reconnect date is stored (tokenExpiresAt stays empty).
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
export const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/snapchat/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeTokens(record) {
  const SecretId = TOKEN_SECRET_PREFIX + record.profileId;
  const SecretString = JSON.stringify(record);
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Snapchat Public Profile tokens for ${record.handle}` }));
  }
}

async function linkSocialAccount(client, brandId, profile) {
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'snapchat\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [profile.id, brandId]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Snapchat profile is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this profile, then the brand's unlinked Snapchat row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='snapchat' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandId, profile.id])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=NULL, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, profile.id, profile.handle]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'snapchat',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, profile.handle, profile.id]);
  return inserted.rows[0].id;
}

export async function completeSnapchatConnect(event, body, connectDatabase, json, now = new Date(), store = storeTokens) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.profile || {};
  const accessToken = String(body?.accessToken || "");
  const refreshToken = String(body?.refreshToken || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !UUID.test(String(raw.id || "")) || !accessToken || !refreshToken) {
    return json(400, { ok: false, error: "brand, profile (id) , accessToken and refreshToken are required" });
  }
  const username = raw.username && /^[A-Za-z0-9._-]{1,60}$/.test(String(raw.username)) ? String(raw.username) : null;
  const displayName = raw.displayName ? String(raw.displayName).slice(0, 120) : null;
  const profile = { id: String(raw.id).toLowerCase(), username, displayName, handle: username ? "@" + username : displayName || String(raw.id) };
  const seconds = Number(body?.expiresIn);
  const accessExpiresAt = new Date(now.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1800) * 1000);
  let client;
  try {
    client = await connectDatabase();
    const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
    if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
    // Tokens first: a row that says "connected" must always have tokens behind it.
    await store({
      accessToken, accessExpiresAt: accessExpiresAt.toISOString(), refreshToken, profileId: profile.id,
      username, displayName, handle: profile.handle, brand, connectedAt: now.toISOString()
    });
    const socialAccountId = await linkSocialAccount(client, brandRow.id, profile);
    return json(200, { ok: true, brand, socialAccountId, profile: { id: profile.id, handle: profile.handle } });
  } catch (error) {
    console.error("[snapchat-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Snapchat connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
