/**
 * "Connect Threads" completion for Elettro OS (Meta app "Elettro OS", Threads app 29447881421485899).
 * The web app trades Threads' one-time code, upgrades to a 60-day token and reads the
 * profile (this Lambda runs in a VPC without internet egress), then sends both here.
 * The token goes to Secrets Manager (never Postgres) and the profile links to the brand's
 * threads SocialAccount with tokenExpiresAt, so the reconnect countdown and banner cover it.
 * Threads tokens can be refreshed (th_refresh_token) any time after 24 hours and before expiry.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";
import { expiresAtFrom } from "./linkedin-connect.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/threads/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeAccessToken(user, accessToken, expiresAt, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + user.id;
  const SecretString = JSON.stringify({
    accessToken, userId: user.id, username: user.username, brand, expiresAt: expiresAt.toISOString(), connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Threads access token for ${user.handle}` }));
  }
}

async function linkSocialAccount(client, brandId, user, expiresAt) {
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'threads\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [user.id, brandId]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Threads profile is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this profile, then the brand's unlinked Threads row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='threads' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandId, user.id])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=$4, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, user.id, user.handle, expiresAt]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","tokenExpiresAt","updatedAt")
     VALUES ($1,'threads',$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, user.handle, user.id, expiresAt]);
  return inserted.rows[0].id;
}

export async function completeThreadsConnect(event, body, connectDatabase, json, now = new Date(), store = storeAccessToken) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.user || {};
  const accessToken = String(body?.accessToken || "");
  const username = raw.username && /^[A-Za-z0-9._]{1,30}$/.test(String(raw.username)) ? String(raw.username) : null;
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^\d{5,25}$/.test(String(raw.id || "")) || !accessToken) {
    return json(400, { ok: false, error: "brand, user and accessToken are required" });
  }
  const user = { id: String(raw.id), username, handle: username ? "@" + username : String(raw.id) };
  const expiresAt = expiresAtFrom(body?.expiresIn, now);
  let client;
  try {
    client = await connectDatabase();
    const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
    if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
    // Token first: a row that says "connected" must always have a token behind it.
    await store(user, accessToken, expiresAt, brand);
    const socialAccountId = await linkSocialAccount(client, brandRow.id, user, expiresAt);
    return json(200, { ok: true, brand, socialAccountId, user: { id: user.id, handle: user.handle }, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[threads-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Threads connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
