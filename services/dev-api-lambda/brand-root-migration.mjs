// One-time DEV cutover: /1---elettro-brand-os/{brand} -> /1---elettro-brand-os/brands/{brand}.
// The brands/ trees are Dropbox *copies*, so every file has a new Dropbox ID. This
// rewrites registered assets to the verified copy IDs in place (Asset.id, statuses,
// metadata and storageRootId are preserved), updates the six BrandStorageRoot rows in
// place and resets the sync cursor. IAM-invoke only. Fails closed on any ambiguity.
// The mapping comes from scripts/build-dropbox-brand-id-map-20261017.py.

export const MIGRATION = "dropbox-brand-roots-20261017";
export const BRANDS = ["stashbox","elettro","solarmeister","neckermann-strom","weightlossdavie","therasbox"];
const OLD = slug => `/1---elettro-brand-os/${slug}`;
const NEW = slug => `/1---elettro-brand-os/brands/${slug}`;
const T = {asset:`"_mig_${MIGRATION.replace(/-/g,"_")}_asset"`,root:`"_mig_${MIGRATION.replace(/-/g,"_")}_root"`,
 conn:`"_mig_${MIGRATION.replace(/-/g,"_")}_conn"`,audit:`"_mig_${MIGRATION.replace(/-/g,"_")}_audit"`};

const underOld = (value, slug) => typeof value === "string" && (value.toLowerCase() === OLD(slug) || value.toLowerCase().startsWith(OLD(slug) + "/"));

export function validateMapping(mapping) {
  const failures = [];
  if (!Array.isArray(mapping) || !mapping.length) return ["mapping is empty"];
  const olds = new Set(), news = new Set();
  for (const m of mapping) {
    if (!BRANDS.includes(m?.brand)) failures.push(`unknown brand in mapping: ${m?.brand}`);
    else if (!/^id:/.test(m.oldId || "") || !/^id:/.test(m.newId || "") || m.oldId === m.newId) failures.push(`bad ids for ${m.oldPathLower}`);
    else if (!underOld(m.oldPathLower, m.brand) || !String(m.newPathLower || "").startsWith(NEW(m.brand) + "/") ||
      m.oldPathLower.slice(OLD(m.brand).length) !== m.newPathLower.slice(NEW(m.brand).length)) failures.push(`path mismatch for ${m.oldPathLower}`);
    if (olds.has(m?.oldId) || news.has(m?.newId)) failures.push(`duplicate id in mapping: ${m?.oldId}`);
    olds.add(m?.oldId); news.add(m?.newId);
  }
  return failures;
}

function assetIds(asset) {
  const meta = asset.sourceMetadata && typeof asset.sourceMetadata === "object" ? asset.sourceMetadata : {};
  return [...new Set([asset.sourceFileId, asset.sourceExternalId, meta.dropboxFileId].filter(v => typeof v === "string" && v))];
}

// Pure planner: given current rows, decide every write or refuse.
export function planMigration({mapping, assets, roots, brandIdBySlug}) {
  const failures = validateMapping(mapping), warnings = [];
  const byOld = new Map(mapping.map(m => [m.oldId, m])), byNew = new Map(mapping.map(m => [m.newId, m]));
  const slugByBrandId = new Map([...brandIdBySlug].map(([slug, id]) => [id, slug]));
  const updates = [], claimed = new Map(), unmapped = [];
  let alreadyMigrated = 0;
  for (const asset of assets) {
    const ids = assetIds(asset), slug = slugByBrandId.get(asset.brandId);
    const old = ids.filter(id => byOld.has(id)), fresh = ids.filter(id => byNew.has(id));
    if (!old.length && !fresh.length) {
      // Pre-existing stale/unavailable source IDs stay untouched for human review.
      if (slug && [asset.sourcePath, asset.sourcePathLower, asset.sourceUrl].some(v => underOld(v, slug)))
        unmapped.push({assetId: asset.id, brand: slug, ids, sourcePath: asset.sourcePath ?? asset.sourceUrl ?? null});
      continue;
    }
    if (ids.length !== 1) { failures.push(`asset ${asset.id} has inconsistent Dropbox ids ${ids.join(",")}`); continue; }
    const m = byOld.get(ids[0]) || byNew.get(ids[0]);
    if (brandIdBySlug.get(m.brand) !== asset.brandId) { failures.push(`asset ${asset.id} brand does not match mapped file ${m.newPathLower}`); continue; }
    if (claimed.has(m.newId)) { failures.push(`assets ${claimed.get(m.newId)} and ${asset.id} both resolve to ${m.newId}`); continue; }
    claimed.set(m.newId, asset.id);
    if (fresh.length) { alreadyMigrated++; continue; }
    if (asset.contentHash && m.contentHash && asset.contentHash !== m.contentHash)
      warnings.push(`asset ${asset.id} stored contentHash differs from current Dropbox file (refreshed on next sync)`);
    const swap = v => v === m.oldId ? m.newId : v;
    const meta = asset.sourceMetadata && typeof asset.sourceMetadata === "object" ? {...asset.sourceMetadata} : {};
    if (meta.dropboxFileId) meta.dropboxFileId = swap(meta.dropboxFileId);
    for (const key of ["path", "path_display"]) if (typeof meta[key] === "string") meta[key] = m.newPathDisplay;
    if (typeof meta.path_lower === "string") meta.path_lower = m.newPathLower;
    if ("rev" in meta && m.newRev) meta.rev = m.newRev;
    meta.brandRootMigration = {migration: MIGRATION, previousDropboxFileId: m.oldId, previousPathLower: m.oldPathLower};
    updates.push({assetId: asset.id, brand: m.brand, oldId: m.oldId, newId: m.newId,
      oldPath: asset.sourcePath ?? asset.sourceUrl ?? null, newPath: m.newPathDisplay,
      set: {sourceFileId: swap(asset.sourceFileId), sourceExternalId: swap(asset.sourceExternalId),
        sourcePath: typeof asset.sourcePath === "string" ? m.newPathDisplay : asset.sourcePath,
        sourcePathLower: typeof asset.sourcePathLower === "string" ? m.newPathLower : asset.sourcePathLower,
        sourceUrl: typeof asset.sourceUrl === "string" && asset.sourceUrl.startsWith("/") ? m.newPathDisplay : asset.sourceUrl,
        sourceMetadata: meta}});
  }
  const rootUpdates = [];
  for (const slug of BRANDS) {
    const brandId = brandIdBySlug.get(slug);
    if (!brandId) { failures.push(`brand ${slug} missing`); continue; }
    const rows = roots.filter(r => r.brandId === brandId);
    const perConn = new Map();
    for (const r of rows) perConn.set(r.storageConnectionId, (perConn.get(r.storageConnectionId) || 0) + 1);
    if ([...perConn.values()].some(n => n > 1)) failures.push(`brand ${slug} has several roots on one connection`);
    if (!rows.length) warnings.push(`brand ${slug} has no BrandStorageRoot row`);
    for (const r of rows) {
      if (r.rootPathLower === NEW(slug)) continue;
      if (r.rootPathLower !== OLD(slug)) { failures.push(`brand ${slug} has unexpected root ${r.rootPath}`); continue; }
      rootUpdates.push({rootId: r.id, brand: slug, from: r.rootPath, to: NEW(slug)});
    }
  }
  return {failures, warnings, updates, rootUpdates, alreadyMigrated, unmapped};
}

const statusSummary = `SELECT b."slug", count(*)::int AS assets,
  count(DISTINCT a."id") FILTER (WHERE a."approvalStatus"='approved')::int AS approved,
  md5(string_agg(a."id"::text||a."approvalStatus"||a."ingestStatus"||a."enrichmentStatus"||coalesce(a."storageRootId"::text,'')
    ||coalesce(array_to_string(a."tags",','),'')||coalesce(a."title",''), '|' ORDER BY a."id")) AS fingerprint
  FROM "Asset" a JOIN "Brand" b ON b."id"=a."brandId" WHERE b."slug"=ANY($1::text[]) GROUP BY b."slug" ORDER BY b."slug"`;

export async function runBrandRootMigration(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = ["apply", "rollback", "verify"].includes(event.mode) ? event.mode : "dry-run";
  if (mode === "verify") return verifyAgainstBackup(connectDatabase, json);
  let client, committed = false;
  try {
    client = await connectDatabase();
    await client.query("BEGIN");
    await client.query('LOCK TABLE "Asset","BrandStorageRoot","StorageConnection" IN SHARE ROW EXCLUSIVE MODE');
    if (mode === "rollback") {
      const result = await rollback(client);
      await client.query("COMMIT"); committed = true;
      return json(200, {ok: true, mode, ...result});
    }
    const brands = await client.query('SELECT "id","slug" FROM "Brand" WHERE "slug"=ANY($1::text[])', [BRANDS]);
    const brandIdBySlug = new Map(brands.rows.map(r => [r.slug, r.id]));
    const brandIds = [...brandIdBySlug.values()];
    const mapping = Array.isArray(event.mapping) ? event.mapping : [];
    const allIds = mapping.flatMap(m => [m.oldId, m.newId]);
    const assets = (await client.query(`SELECT "id","brandId","sourceFileId","sourceExternalId","sourcePath","sourcePathLower","sourceUrl","sourceMetadata","contentHash"
      FROM "Asset" WHERE "sourceType"='dropbox' AND ("brandId"=ANY($1::uuid[]) OR "sourceFileId"=ANY($2::text[])
      OR "sourceExternalId"=ANY($2::text[]) OR "sourceMetadata"->>'dropboxFileId'=ANY($2::text[]))`, [brandIds, allIds])).rows;
    const roots = (await client.query('SELECT "id","brandId","storageConnectionId","rootPath","rootPathLower" FROM "BrandStorageRoot" WHERE "brandId"=ANY($1::uuid[])', [brandIds])).rows;
    const plan = planMigration({mapping, assets, roots, brandIdBySlug});
    if (event.expectedMappedFiles !== undefined && mapping.length !== event.expectedMappedFiles)
      plan.failures.push(`mapping has ${mapping.length} files, expected ${event.expectedMappedFiles}`);
    const before = (await client.query(statusSummary, [BRANDS])).rows;
    const summary = {mode, mappedFiles: mapping.length, assetsToUpdate: plan.updates.length, alreadyMigrated: plan.alreadyMigrated,
      rootsToUpdate: plan.rootUpdates, unmappedOldRootAssets: plan.unmapped, warnings: plan.warnings, failures: plan.failures, before};
    if (plan.failures.length) { await client.query("ROLLBACK"); return json(409, {ok: false, error: "Migration refused; nothing changed", ...summary}); }

    // Snapshot the first-touch state; reruns never overwrite it.
    await client.query(`CREATE TABLE IF NOT EXISTS ${T.asset} AS SELECT * FROM "Asset" WITH NO DATA`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${T.root} AS SELECT * FROM "BrandStorageRoot" WITH NO DATA`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${T.conn} AS SELECT * FROM "StorageConnection" WITH NO DATA`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${T.audit} ("assetId" uuid PRIMARY KEY, "brand" text, "oldDropboxId" text, "newDropboxId" text,
      "oldPath" text, "newPath" text, "appliedAt" timestamptz DEFAULT now())`);
    await client.query(`INSERT INTO ${T.asset} SELECT a.* FROM "Asset" a WHERE a."brandId"=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM ${T.asset} s WHERE s."id"=a."id")`, [brandIds]);
    await client.query(`INSERT INTO ${T.root} SELECT r.* FROM "BrandStorageRoot" r WHERE r."brandId"=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM ${T.root} s WHERE s."id"=r."id")`, [brandIds]);
    await client.query(`INSERT INTO ${T.conn} SELECT c.* FROM "StorageConnection" c WHERE c."id" IN (SELECT "storageConnectionId" FROM "BrandStorageRoot" WHERE "brandId"=ANY($1::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM ${T.conn} s WHERE s."id"=c."id")`, [brandIds]);

    for (const u of plan.updates) {
      const s = u.set;
      const r = await client.query(`UPDATE "Asset" SET "sourceFileId"=$2,"sourceExternalId"=$3,"sourcePath"=$4,"sourcePathLower"=$5,"sourceUrl"=$6,
        "sourceMetadata"=$7::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
        [u.assetId, s.sourceFileId, s.sourceExternalId, s.sourcePath, s.sourcePathLower, s.sourceUrl, JSON.stringify(s.sourceMetadata)]);
      if (r.rowCount !== 1) throw new Error(`asset ${u.assetId} update affected ${r.rowCount} rows`);
      await client.query(`INSERT INTO ${T.audit} ("assetId","brand","oldDropboxId","newDropboxId","oldPath","newPath") VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT ("assetId") DO NOTHING`, [u.assetId, u.brand, u.oldId, u.newId, u.oldPath, u.newPath]);
    }
    for (const r of plan.rootUpdates)
      await client.query('UPDATE "BrandStorageRoot" SET "rootPath"=$2,"rootPathLower"=$3,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [r.rootId, r.to, r.to.toLowerCase()]);
    const cursors = await client.query(`UPDATE "StorageConnection" SET "syncCursor"=NULL,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id" IN (SELECT "storageConnectionId" FROM "BrandStorageRoot" WHERE "brandId"=ANY($1::uuid[])) RETURNING "id"`, [brandIds]);

    // Post-conditions inside the transaction: nothing still points at a source ID,
    // no copy ID is shared, and statuses/metadata fingerprints are unchanged.
    const oldIds = mapping.map(m => m.oldId), newIds = mapping.map(m => m.newId);
    const stale = await client.query(`SELECT count(*)::int n FROM "Asset" WHERE "sourceFileId"=ANY($1::text[]) OR "sourceExternalId"=ANY($1::text[])
      OR "sourceMetadata"->>'dropboxFileId'=ANY($1::text[])`, [oldIds]);
    const dupes = await client.query(`SELECT coalesce("sourceFileId","sourceExternalId") id, count(*)::int n FROM "Asset"
      WHERE coalesce("sourceFileId","sourceExternalId")=ANY($1::text[]) GROUP BY 1 HAVING count(*)>1`, [newIds]);
    const after = (await client.query(statusSummary, [BRANDS])).rows;
    if (stale.rows[0].n) throw new Error(`${stale.rows[0].n} assets still reference source Dropbox IDs`);
    if (dupes.rows.length) throw new Error(`duplicate assets for copy IDs: ${dupes.rows.map(r => r.id).join(",")}`);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("asset counts, statuses or metadata fingerprints changed");

    const result = {...summary, cursorsReset: cursors.rowCount, after,
      sample: plan.updates.slice(0, 5).map(u => ({assetId: u.assetId, oldId: u.oldId, newId: u.newId, newPath: u.newPath}))};
    if (mode !== "apply") { await client.query("ROLLBACK"); return json(200, {ok: true, note: "Dry run rolled back; nothing changed", ...result}); }
    await client.query("COMMIT"); committed = true;
    console.info(`[${MIGRATION}] applied`, JSON.stringify({assets: plan.updates.length, roots: plan.rootUpdates.length}));
    return json(200, {ok: true, ...result});
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    console.error(`[${MIGRATION}] failed`, error);
    return json(500, {ok: false, mode, error: error instanceof Error ? error.message : "Migration failed; rolled back"});
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

// Read-only: compare every backed-up asset with its current row, column by column.
const PRESERVED = ["brandId","storageRootId","collectionId","campaignId","intakeBatchId","approvalStatus","ingestStatus","enrichmentStatus",
  "title","aiDescription","topic","contentGroup","creativeFamily","creatorNote","creativeNotes","tags","commerceLinks","priority",
  "eligibilityType","eligibleFrom","eligibleUntil","allowedDestinations","excludedDestinations","firstApprovedAt","retiredAt","aiSuggestions"];
async function verifyAgainstBackup(connectDatabase, json) {
  let client;
  try {
    client = await connectDatabase();
    const changed = {};
    for (const col of PRESERVED) {
      const r = await client.query(`SELECT a."id", s."${col}"::text AS before, a."${col}"::text AS after FROM ${T.asset} s JOIN "Asset" a ON a."id"=s."id"
        WHERE a."${col}" IS DISTINCT FROM s."${col}" ORDER BY a."id"`);
      if (r.rows.length) changed[col] = {count: r.rows.length, transitions: Object.entries(r.rows.reduce((m, x) => {
        const k = `${x.before} -> ${x.after}`; m[k] = (m[k] || 0) + 1; return m; }, {})).slice(0, 10), sample: r.rows.slice(0, 3)};
    }
    const missing = await client.query(`SELECT count(*)::int n FROM ${T.asset} s WHERE NOT EXISTS (SELECT 1 FROM "Asset" a WHERE a."id"=s."id")`);
    const added = await client.query(`SELECT b."slug", count(*)::int n FROM "Asset" a JOIN "Brand" b ON b."id"=a."brandId"
      WHERE b."slug"=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM ${T.asset} s WHERE s."id"=a."id") GROUP BY 1`, [BRANDS]);
    const dupes = await client.query(`SELECT coalesce("sourceFileId","sourceExternalId") id, count(*)::int n FROM "Asset"
      WHERE "sourceType"='dropbox' AND coalesce("sourceFileId","sourceExternalId") IS NOT NULL GROUP BY 1 HAVING count(*)>1`);
    const roots = await client.query(`SELECT b."slug", r."rootPath" FROM "BrandStorageRoot" r JOIN "Brand" b ON b."id"=r."brandId" WHERE b."slug"=ANY($1::text[]) ORDER BY 1`, [BRANDS]);
    const audited = await client.query(`SELECT count(*)::int n FROM ${T.audit}`);
    return json(200, {ok: true, mode: "verify", backedUpAssets: (await client.query(`SELECT count(*)::int n FROM ${T.asset}`)).rows[0].n,
      auditedRemaps: audited.rows[0].n, missingSinceBackup: missing.rows[0].n, addedSinceBackup: added.rows, duplicateDropboxIds: dupes.rows,
      roots: roots.rows, changedPreservedColumns: changed});
  } catch (error) {
    return json(500, {ok: false, mode: "verify", error: error instanceof Error ? error.message : "Verify failed"});
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

// Restores only the columns this migration wrote, so later approvals/edits survive.
async function rollback(client) {
  const exists = await client.query("SELECT to_regclass($1) t", [T.audit.replace(/"/g, "")]);
  if (!exists.rows[0].t) throw new Error("No migration audit table; nothing to roll back");
  const assets = await client.query(`UPDATE "Asset" a SET "sourceFileId"=s."sourceFileId","sourceExternalId"=s."sourceExternalId","sourcePath"=s."sourcePath",
    "sourcePathLower"=s."sourcePathLower","sourceUrl"=s."sourceUrl","sourceMetadata"=s."sourceMetadata","updatedAt"=CURRENT_TIMESTAMP
    FROM ${T.asset} s, ${T.audit} m WHERE a."id"=s."id" AND a."id"=m."assetId"`);
  const roots = await client.query(`UPDATE "BrandStorageRoot" r SET "rootPath"=s."rootPath","rootPathLower"=s."rootPathLower","updatedAt"=CURRENT_TIMESTAMP
    FROM ${T.root} s WHERE r."id"=s."id"`);
  const cursors = await client.query(`UPDATE "StorageConnection" c SET "syncCursor"=NULL,"updatedAt"=CURRENT_TIMESTAMP FROM ${T.conn} s WHERE c."id"=s."id"`);
  await client.query(`DROP TABLE ${T.audit}`);
  return {assetsRestored: assets.rowCount, rootsRestored: roots.rowCount, cursorsReset: cursors.rowCount,
    note: "Asset identity/path columns and roots restored; backup tables kept. Redeploy the previous Lambda code before syncing."};
}
