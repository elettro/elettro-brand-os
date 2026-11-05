/**
 * "Connect Substack" completion for Elettro OS.
 * Substack has no OAuth and no official publishing API. The owner pastes the browser session cookie of a logged-in
 * Substack account on /connections; the web app checks it against substack.com (this Lambda runs in a VPC without
 * internet egress) and sends the result here. This Lambda keeps the cookie in Secrets Manager (never in Postgres)
 * and links the publication to the brand's Substack SocialAccount (externalAccountId = the publication subdomain).
 * The cookie expires on Substack's schedule, so tokenExpiresAt stays NULL and a rejected cookie surfaces as a failed
 * post asking for a reconnect.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/substack/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storeLogin(subdomain, cookie, info, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + subdomain;
  const SecretString = JSON.stringify({ cookie, subdomain, userId: info.userId, handle: info.handle, brand, connectedAt: new Date().toISOString() });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Substack login for ${subdomain}.substack.com` }));
  }
}

async function linkSocialAccount(client, brand, subdomain, name) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'substack\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [subdomain, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Substack publication is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='substack' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, subdomain])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=NULL, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, subdomain, name]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,'substack',$2,$3,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, name, subdomain]);
  return inserted.rows[0].id;
}

export async function completeSubstackConnect(event, body, connectDatabase, json) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const subdomain = String(body?.subdomain || "").toLowerCase();
  const cookie = String(body?.cookie || "");
  const userId = String(body?.userId || "");
  const handle = body?.handle ? String(body.handle).replace(/^@/, "").slice(0, 80) : null;
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain) || !/^[0-9]{1,20}$/.test(userId) ||
      cookie.length < 20 || cookie.length > 8000 || /[\r\n]/.test(cookie)) {
    return json(400, { ok: false, error: "brand, subdomain, userId and cookie are required" });
  }
  const name = `${subdomain}.substack.com`;
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, subdomain, name);
    await storeLogin(subdomain, cookie, { userId, handle }, brand);
    return json(200, { ok: true, brand, socialAccountId, account: { publication: name, handle } });
  } catch (error) {
    console.error("[substack-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Substack connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
