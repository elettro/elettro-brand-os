/**
 * "Connect Meta" completion for Elettro OS (Meta app "Elettro OS" 1186765853901766).
 * The web app trades Facebook's one-time code, upgrades to a 60-day user token and
 * reads the brand's Page (this Lambda runs in a VPC without internet egress), then
 * sends the Page, its Page token and the linked Instagram account here. Page tokens
 * read with a long-lived user token do not expire, so tokenExpiresAt stays null.
 * The token goes to Secrets Manager (never Postgres); the Page links to the brand's
 * facebook SocialAccount and the Instagram account to its instagram SocialAccount.
 */
import { timingSafeEqual } from "node:crypto";
import { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});
const TOKEN_SECRET_PREFIX = "elettro-brand-os-dev/meta/";

class ConnectError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function storePageToken(page, instagram, pageToken, brand) {
  const SecretId = TOKEN_SECRET_PREFIX + page.id;
  const SecretString = JSON.stringify({
    pageAccessToken: pageToken, pageId: page.id, pageName: page.name,
    instagramId: instagram?.id || null, instagramUsername: instagram?.username || null,
    brand, connectedAt: new Date().toISOString()
  });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId, SecretString }));
  } catch (error) {
    if (error?.name !== "ResourceNotFoundException") throw error;
    await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: `Meta Page token for ${page.name}` }));
  }
}

async function linkSocialAccount(client, brandId, destination, externalAccountId, accountName) {
  const elsewhere = await client.query(
    'SELECT 1 FROM "SocialAccount" WHERE "destination"=$1 AND "externalAccountId"=$2 AND "brandId"<>$3 LIMIT 1',
    [destination, externalAccountId, brandId]);
  if (elsewhere.rows.length) throw new ConnectError(409, `That ${destination} account is already connected to another brand`);
  // Prefer the row already linked to this account, then the brand's unlinked row from the planner seed.
  const existing = (await client.query(`
    SELECT "id" FROM "SocialAccount"
    WHERE "brandId"=$1 AND "destination"=$2 AND ("externalAccountId"=$3 OR "externalAccountId" IS NULL)
    ORDER BY ("externalAccountId"=$3) DESC NULLS LAST, "createdAt" LIMIT 1`, [brandId, destination, externalAccountId])).rows[0];
  if (existing) {
    await client.query(
      'UPDATE "SocialAccount" SET "externalAccountId"=$2, "accountName"=$3, "status"=\'active\', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      [existing.id, externalAccountId, accountName]);
    return existing.id;
  }
  const inserted = await client.query(
    `INSERT INTO "SocialAccount" ("brandId","destination","accountName","externalAccountId","updatedAt")
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP) RETURNING "id"`, [brandId, destination, accountName, externalAccountId]);
  return inserted.rows[0].id;
}

export async function completeMetaConnect(event, body, connectDatabase, json, store = storePageToken) {
  const headers = event?.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const page = { id: String(body?.page?.id || ""), name: String(body?.page?.name || "") };
  const pageToken = String(body?.pageToken || "");
  const ig = body?.instagram;
  const instagram = ig ? { id: String(ig.id || ""), username: ig.username ? String(ig.username) : null } : null;
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !/^\d{5,25}$/.test(page.id) || !pageToken || (instagram && !/^\d{5,25}$/.test(instagram.id))) {
    return json(400, { ok: false, error: "brand, page and pageToken are required" });
  }
  page.name ||= page.id;
  let client;
  try {
    client = await connectDatabase();
    const brandRow = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 LIMIT 1', [brand])).rows[0];
    if (!brandRow) throw new ConnectError(404, `Unknown brand ${brand}`);
    // Token first: a row that says "connected" must always have a token behind it.
    await store(page, instagram, pageToken, brand);
    const facebookAccountId = await linkSocialAccount(client, brandRow.id, "facebook", page.id, page.name);
    const instagramAccountId = instagram
      ? await linkSocialAccount(client, brandRow.id, "instagram", instagram.id, instagram.username ? "@" + instagram.username : instagram.id)
      : null;
    return json(200, { ok: true, brand, page, instagram, facebookAccountId, instagramAccountId });
  } catch (error) {
    console.error("[meta-connect] failed", error?.name, error?.message);
    return json(error?.statusCode || 500, { ok: false, error: error?.message || "Meta connect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
