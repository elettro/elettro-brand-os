/**
 * "Connect LinkedIn" completion for Elettro OS (LinkedIn app "Elettro OS Personal").
 * The web app trades LinkedIn's one-time code and reads the member (this Lambda
 * runs in a VPC without internet egress), then sends both here. This Lambda keeps
 * the access token in Secrets Manager (never in Postgres) and links the member to
 * the brand's LinkedIn SocialAccount with tokenExpiresAt: member tokens last 60
 * days and LinkedIn issues no refresh token, so Dean reconnects before that date.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/linkedin/";
const DEFAULT_TTL_SECONDS = 60 * 86_400;

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// LinkedIn says expires_in (seconds); fall back to its documented 60 days if it is missing or odd.
export function expiresAtFrom(expiresIn, now = new Date()) {
  const seconds = Number(expiresIn);
  const ttl = Number.isFinite(seconds) && seconds > 0 && seconds <= 366 * 86_400 ? seconds : DEFAULT_TTL_SECONDS;
  return new Date(now.getTime() + ttl * 1000);
}

async function storeAccessToken(member, accessToken, scope, expiresAt, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + member.id;
  const SecretString = JSON.stringify({
    accessToken, scope, memberUrn: member.urn, brand, expiresAt: expiresAt.toISOString(), connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `LinkedIn member access token for ${member.name}` }));
  }
}

async function linkSocialAccount(client, brand, member, expiresAt) {
  const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
  if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'linkedin\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [member.urn, brandRow.id]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That LinkedIn profile is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this member, then the brand's unlinked LinkedIn row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='linkedin' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandRow.id, member.urn])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=$4, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, member.urn, member.name, expiresAt]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","tokenExpiresAt","updatedAt")
     VALUES ($1,'linkedin',$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandRow.id, member.name, member.urn, expiresAt]);
  return inserted.rows[0].id;
}

export async function completeLinkedinConnect(event, body, connectDatabase, json, now = new Date()) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.member || {};
  const accessToken = String(body?.accessToken || "");
  // OpenID "sub" is the member id behind urn:li:person:<sub>.
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^[A-Za-z0-9_-]{4,64}$/.test(String(raw.id || "")) || !accessToken) {
    return json(400, { ok: false, error: "brand, member and accessToken are required" });
  }
  const member = { id: String(raw.id), urn: `urn:li:person:${raw.id}`, name: String(raw.name || raw.id) };
  const expiresAt = expiresAtFrom(body?.expiresIn, now);
  let client;
  try {
    client = await connectDatabase();
    const socialAccountId = await linkSocialAccount(client, brand, member, expiresAt);
    await storeAccessToken(member, accessToken, body?.scope || null, expiresAt, brand);
    return json(200, { ok: true, brand, socialAccountId, member: { urn: member.urn, name: member.name }, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[linkedin-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "LinkedIn connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
