/**
 * "Connect YouTube" completion for Elettro OS (Google Cloud project elettro-os).
 * The web app trades Google's one-time code and reads the picked channel (this
 * Lambda runs in a VPC without internet egress), then sends both here. This
 * Lambda keeps the refresh token in Secrets Manager (never in Postgres) and
 * links the channel to the brand's YouTube SocialAccount. publishingMode is
 * left as-is until a first test post succeeds.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/youtube/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

export function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeRefreshToken(channel, refreshToken, scope, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + channel.id;
  const SecretString = JSON.stringify({
    refreshToken, scope, channelId: channel.id, brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `YouTube refresh token for ${channel.title}` }));
  }
}

async function linkSocialAccount(client, brand, channel) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'youtube\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [channel.id, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That channel is already connected to another brand");
  const accountName = channel.handle || channel.title;
  // Prefer the row already linked to this channel, then the brand's unlinked YouTube row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='youtube' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, channel.id])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, channel.id, accountName]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'youtube',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, accountName, channel.id]);
  return inserted.rows[0].id;
}

export async function completeYoutubeConnect(event, body, connectDatabase, json) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.channel || {};
  const refreshToken = String(body?.refreshToken || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^UC[A-Za-z0-9_-]{10,40}$/.test(String(raw.id || "")) || !refreshToken) {
    return json(400, { ok: false, error: "brand, channel and refreshToken are required" });
  }
  const channel = { id: String(raw.id), title: String(raw.title || raw.id), handle: raw.handle ? String(raw.handle) : null };
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, channel);
    await storeRefreshToken(channel, refreshToken, body?.scope || null, brand);
    return json(200, { ok: true, brand, socialAccountId, channel });
  } catch (error) {
    console.error("[youtube-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "YouTube connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
