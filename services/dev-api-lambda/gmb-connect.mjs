/**
 * "Connect Google Business Profile" completion for Elettro OS (Google Cloud project elettro-os).
 * The web app trades Google's one-time code and finds the brand's profile (this
 * Lambda runs in a VPC without internet egress), then sends both here. This
 * Lambda keeps the refresh token in Secrets Manager (never in Postgres) and
 * links the profile to the brand's gmb SocialAccount. publishingMode is left
 * as-is: GBP posting waits on the business-intelligence layer.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/gmb/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

export function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Location ids look like accounts/123/locations/456; the secret is keyed by the location number.
export const LOCATION_ID = /^accounts\/\d{5,30}\/locations\/(\d{5,30})$/;

async function storeRefreshToken(location, refreshToken, scope, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + LOCATION_ID.exec(location.id)[1];
  const SecretString = JSON.stringify({
    refreshToken, scope, locationId: location.id, brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Google Business Profile refresh token for ${location.title}` }));
  }
}

async function linkSocialAccount(client, brand, location) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'gmb\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [location.id, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That profile is already connected to another brand");
  // Prefer the row already linked to this profile, then the brand's unlinked gmb row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='gmb' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, location.id])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, location.id, location.title]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'gmb',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, location.title, location.id]);
  return inserted.rows[0].id;
}

export async function completeGmbConnect(event, body, connectDatabase, json) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.location || {};
  const refreshToken = String(body?.refreshToken || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !LOCATION_ID.test(String(raw.id || "")) || !refreshToken) {
    return json(400, { ok: false, error: "brand, location and refreshToken are required" });
  }
  const location = { id: String(raw.id), title: String(raw.title || raw.id).slice(0, 120) };
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, location);
    await storeRefreshToken(location, refreshToken, body?.scope || null, brand);
    return json(200, { ok: true, brand, socialAccountId, location });
  } catch (error) {
    console.error("[gmb-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Google Business Profile connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
