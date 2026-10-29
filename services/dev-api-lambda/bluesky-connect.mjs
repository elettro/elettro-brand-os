/**
 * "Connect Bluesky" completion for Elettro OS (AT Protocol OAuth, confidential client).
 * The web app runs the OAuth handshake (this Lambda runs in a VPC without internet egress) and sends the
 * saved session here: the DPoP key plus the token set. The session goes to Secrets Manager (never Postgres)
 * and the account links to the brand's bluesky SocialAccount with tokenExpiresAt, so the reconnect
 * countdown and banner cover it. Bluesky refresh tokens rotate on every use, so a publisher that restores
 * the session must write the new one back to the same secret.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

const secrets = new SecretsManagerClient({});
export const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/bluesky/";
// Refresh tokens for a confidential client last up to about 180 days; each refresh issues a new one.
export const REFRESH_WINDOW_DAYS = 180;

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Secrets Manager names allow letters, digits and /_+=.@- only, so "did:plc:abc" becomes "did_plc_abc". */
export const secretNameFor = (did) => TOKEN_SECRET_PREFIX + String(did).replace(/:/g, "_");

async function storeSession(account, session, expiresAt, brand) {
  const SecretId = secretNameFor(account.did);
  const SecretString = JSON.stringify({
    did: account.did, handle: account.handle, pds: account.pds, brand, session,
    expiresAt: expiresAt.toISOString(), connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Bluesky OAuth session for ${account.handle}` }));
  }
}

async function linkSocialAccount(client, brandId, account, expiresAt) {
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=\'bluesky\' AND "externalAccountId"=$1 AND "brandId"<>$2 LIMIT 1',
    [account.did, brandId]);
  if (elsewhere.rows.length) throw new ConnectError(409, "That Bluesky account is already connected to another brand");
  await ensureTokenExpiryColumn(client);
  // Prefer the row already linked to this account, then the brand's unlinked Bluesky row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"='bluesky' AND ("externalAccountId"=$2 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$2) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandId, account.did])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "tokenExpiresAt"=$4, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, account.did, account.handle, expiresAt]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","tokenExpiresAt","updatedAt")
     VALUES ($1,'bluesky',$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, account.handle, account.did, expiresAt]);
  return inserted.rows[0].id;
}

export async function completeBlueskyConnect(event, body, connectDatabase, json, now = new Date(), store = storeSession) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const raw = body?.account || {};
  const session = body?.session;
  const did = String(raw.did || "");
  const handleName = /^[A-Za-z0-9.-]{3,253}$/.test(String(raw.handle || "")) ? String(raw.handle) : null;
  const pds = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(String(raw.pds || "")) ? String(raw.pds) : null;
  const sessionOk = session && typeof session === "object" && session.tokenSet?.refresh_token && session.dpopJwk;
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^did:(plc|web):[A-Za-z0-9._:-]{4,200}$/.test(did) || !pds || !sessionOk) {
    return json(400, { ok: false, error: "brand, account (did, pds) and a saved session are required" });
  }
  const account = { did, handle: handleName ? "@" + handleName : did, pds };
  const expiresAt = new Date(now.getTime() + REFRESH_WINDOW_DAYS * 86_400_000);
  let client;
  try {
    client = await connectDatabase();
    const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
    if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
    // Session first: a row that says "connected" must always have a login behind it.
    await store(account, session, expiresAt, brand);
    const socialAccountId = await linkSocialAccount(client, brandRow.id, account, expiresAt);
    return json(200, { ok: true, brand, socialAccountId, account: { did, handle: account.handle }, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("[bluesky-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Bluesky connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
