/**
 * Library + publication history for the test-post buttons on the Connections page
 * (routed through POST /planner/review, which checks the shared key and loads the brand).
 *
 *   assets               search the brand's approved, ready library (picker)
 *   asset                one asset with its Dropbox path, so the web app never trusts a client path
 *   record-publication   log an API post to PublicationLedger (method "api"), which is what
 *                        lights the dashboard's "First test post via API" checkpoint
 *   recent-publications  the brand's latest API posts, newest first
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIBRARY_COLUMNS = `"id","filename","kind","sourcePath","title","aspectRatioLabel","durationMs","mimeType","width","height"`;
const PUBLISH_DESTINATIONS = ["instagram", "facebook", "youtube", "linkedin", "threads", "tiktok", "x", "pinterest", "gmb"];

export async function searchLibrary(client, brand, body) {
  const kind = ["image", "video"].includes(body.kind) ? body.kind : null;
  const q = String(body.q || "").trim().slice(0, 80);
  const limit = Math.min(60, Math.max(1, Math.floor(Number(body.limit) || 36)));
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const rows = (await client.query(`
    SELECT ${LIBRARY_COLUMNS} FROM "Asset"
    WHERE "brandId"=$1 AND "approvalStatus"='approved' AND "ingestStatus"='ready' AND "retiredAt" IS NULL AND "sourcePath" IS NOT NULL
      AND "kind" IN ('image','video') AND ($2::text IS NULL OR "kind"::text=$2)
      AND ($3::text = '' OR "filename" ILIKE '%' || $3 || '%' OR COALESCE("title",'') ILIKE '%' || $3 || '%')
    ORDER BY "updatedAt" DESC LIMIT $4 OFFSET $5`, [brand.id, kind, q, limit + 1, offset])).rows;
  return { code: 200, body: { ok: true, assets: rows.slice(0, limit), more: rows.length > limit, offset } };
}

export async function libraryAsset(client, brand, body) {
  if (!UUID.test(String(body.id || ""))) return { code: 400, body: { ok: false, error: "id is required" } };
  const asset = (await client.query(`
    SELECT ${LIBRARY_COLUMNS} FROM "Asset"
    WHERE "id"=$1 AND "brandId"=$2 AND "approvalStatus"='approved' AND "ingestStatus"='ready' AND "retiredAt" IS NULL`,
    [body.id, brand.id])).rows[0];
  return asset ? { code: 200, body: { ok: true, asset } } : { code: 404, body: { ok: false, error: "Not an approved, ready asset of this brand" } };
}

export async function recordPublication(client, brand, body) {
  const destination = String(body.destination || "").toLowerCase();
  const placement = String(body.placement || "").toLowerCase();
  const externalPostId = String(body.externalPostId || "").slice(0, 200);
  const externalUrl = body.externalUrl ? String(body.externalUrl).slice(0, 500) : null;
  if (!PUBLISH_DESTINATIONS.includes(destination) || !/^[a-z]{2,20}$/.test(placement) || !UUID.test(String(body.assetId || "")) || !externalPostId) {
    return { code: 400, body: { ok: false, error: "destination, placement, assetId and externalPostId are required" } };
  }
  const account = (await client.query(`
    SELECT "id" FROM "SocialAccount" WHERE "brandId"=$1 AND "destination"=$2 AND "status"='active' AND "externalAccountId" IS NOT NULL
    ORDER BY "updatedAt" DESC LIMIT 1`, [brand.id, destination])).rows[0];
  if (!account) return { code: 409, body: { ok: false, error: `No connected ${destination} account` } };
  const row = (await client.query(`
    INSERT INTO "PublicationLedger" ("brandId","socialAccountId","assetId","destination","placement","publishedAt","method",
      "externalPostId","externalUrl","assetFilenameSnapshot","contentGroupSnapshot","creativeFamilySnapshot","topicSnapshot")
    SELECT $1, $2, a."id", $3, $4, CURRENT_TIMESTAMP, 'api', $5, $6, a."filename", a."contentGroup", a."creativeFamily", a."topic"
    FROM "Asset" a WHERE a."id"=$7 AND a."brandId"=$1
    RETURNING "id"`, [brand.id, account.id, destination, placement, externalPostId, externalUrl, body.assetId])).rows[0];
  return row ? { code: 200, body: { ok: true, id: row.id } } : { code: 404, body: { ok: false, error: "Asset not found for this brand" } };
}

export async function recentPublications(client, brand) {
  const rows = (await client.query(`
    SELECT pl."id", pl."destination", pl."placement", pl."publishedAt", pl."externalUrl", pl."assetId", pl."assetFilenameSnapshot" AS "filename"
    FROM "PublicationLedger" pl WHERE pl."brandId"=$1 AND pl."method"='api'
    ORDER BY pl."publishedAt" DESC LIMIT 20`, [brand.id])).rows;
  return { code: 200, body: { ok: true, publications: rows.map((r) => ({ ...r, publishedAt: new Date(r.publishedAt).toISOString() })) } };
}
