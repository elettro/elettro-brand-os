/**
 * "Connect YouTube" completion for Elettro OS (Google Cloud project elettro-os).
 * The web app sends the one-time Google code here; this Lambda trades it for a
 * refresh token, finds the channel that was picked, keeps the token in Secrets
 * Manager (never in Postgres) and links the channel to the brand's YouTube
 * SocialAccount. publishingMode is left as-is until a first test post succeeds.
 */
import { timingSafeEqual } from "node:crypto";
import {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const REDIRECT_URI = "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/connections/youtube/callback";
const GOOGLE_SECRET = process.env.GOOGLE_OAUTH_SECRET_NAME || "elettro-brand-os-dev/google-oauth";
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/youtube/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function googleClient() {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: GOOGLE_SECRET }));
  const value = JSON.parse(response.SecretString || "{}");
  if (!value.clientId || !value.clientSecret) throw new ConnectError(503, "Google OAuth client is not configured");
  return value;
}

async function exchangeCode(code, { clientId, clientSecret }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      client_id: clientId, client_secret: clientSecret
    })
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok) throw new ConnectError(400, `Google rejected the code: ${token.error || response.status}`);
  if (!token.refresh_token) throw new ConnectError(400, "Google returned no refresh token; remove Elettro OS from the account's third-party access and connect again");
  return token;
}

async function pickedChannel(accessToken) {
  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ConnectError(502, `YouTube channel lookup failed: ${body.error?.message || response.status}`);
  const channel = body.items?.[0];
  if (!channel) throw new ConnectError(400, "That Google account has no YouTube channel; pick the channel when Google asks");
  return { id: channel.id, title: channel.snippet?.title || channel.id, handle: channel.snippet?.customUrl || null };
}

async function storeRefreshToken(channel, token, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + channel.id;
  const SecretString = JSON.stringify({
    refreshToken: token.refresh_token, scope: token.scope, channelId: channel.id,
    brand, connectedAt: new Date().toISOString()
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
  const code = String(body?.code || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !code) return json(400, { ok: false, error: "brand and code are required" });
  let client;
  try {
    const token = await exchangeCode(code, await googleClient());
    const channel = await pickedChannel(token.access_token);
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, channel);
    await storeRefreshToken(channel, token, brand);
    return json(200, { ok: true, brand, socialAccountId, channel });
  } catch (error) {
    console.error("[youtube-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "YouTube connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
