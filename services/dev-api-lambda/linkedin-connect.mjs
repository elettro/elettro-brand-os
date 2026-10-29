/**
 * "Connect LinkedIn" completion for Elettro OS. Two kinds of account come through here:
 *  - a member profile (LinkedIn app "Elettro OS Personal"): the access token lasts 60 days and there is no refresh
 *    token, so Dean reconnects before tokenExpiresAt;
 *  - a company page (LinkedIn app "Elettro OS", Community Management API): the access token lasts about 60 days
 *    and comes with a refresh token (about a year), which the linkedin worker uses to renew it.
 * The web app trades LinkedIn's one-time code and reads the member or page (this Lambda runs in a VPC without
 * internet egress), then sends it here. This Lambda keeps the tokens in Secrets Manager (never in Postgres) and
 * links the account to the brand's LinkedIn SocialAccount with tokenExpiresAt. A brand has one LinkedIn account:
 * connecting its page replaces a profile that was linked to it.
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

async function storeAccessToken(member, accessToken, scope, expiresAt, brand, refresh = null) {
  const SecretId = TOKEN_SECRET_PREFIX + member.id;
  const SecretString = JSON.stringify({
    accessToken, scope, memberUrn: member.urn, brand, expiresAt: expiresAt.toISOString(), connectedAt: new Date().toISOString(),
    ...(refresh ? { refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt.toISOString() } : {})
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `LinkedIn ${member.kind === "organization" ? "page" : "member"} access token for ${member.name}` }));
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
  // Prefer the row already linked to this account, then the brand's unlinked LinkedIn row from the planner seed; a page
  // also takes over a member profile that was linked to the brand (one LinkedIn account per brand).
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='linkedin'
      AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL OR ($3 AND "externalAccountId" LIKE 'urn:li:person:%'))
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, ("externalAccountId" IS NULL) DESC, "createdAt" LIMIT 1`,
    [brandRow.id, member.urn, member.kind === "organization"])).rows[0];
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
  const accessToken = String(body?.accessToken || "");
  let member;
  if (body?.page) {
    // A company page: the numeric id behind urn:li:organization:<id>.
    const page = body.page;
    if (!/^\d{1,20}$/.test(String(page.id || ""))) return json(400, { ok: false, error: "page.id must be the numeric LinkedIn page id" });
    member = { id: `org-${page.id}`, urn: `urn:li:organization:${page.id}`, name: String(page.name || page.id), kind: "organization" };
  } else {
    const raw = body?.member || {};
    // OpenID "sub" is the member id behind urn:li:person:<sub>.
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(raw.id || ""))) return json(400, { ok: false, error: "brand, member and accessToken are required" });
    member = { id: String(raw.id), urn: `urn:li:person:${raw.id}`, name: String(raw.name || raw.id), kind: "person" };
  }
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !accessToken) {
    return json(400, { ok: false, error: "brand, member or page, and accessToken are required" });
  }
  const expiresAt = expiresAtFrom(body?.expiresIn, now);
  const refresh = member.kind === "organization" && body?.refreshToken
    ? { token: String(body.refreshToken), expiresAt: expiresAtFrom(body?.refreshExpiresIn || 365 * 86_400, now) }
    : null;
  let client;
  try {
    client = await connectDatabase();
    // A page's reconnect date is when its refresh token dies (the worker renews the access token before that).
    const reconnectBy = refresh ? refresh.expiresAt : expiresAt;
    const socialAccountId = await linkSocialAccount(client, brand, member, reconnectBy);
    await storeAccessToken(member, accessToken, body?.scope || null, expiresAt, brand, refresh);
    return json(200, { ok: true, brand, socialAccountId, member: { urn: member.urn, name: member.name }, kind: member.kind, expiresAt: reconnectBy.toISOString() });
  } catch (error) {
    console.error("[linkedin-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "LinkedIn connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
