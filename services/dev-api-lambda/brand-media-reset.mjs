// One-time DEV brand media reset (2026-10-17, requested by the account owner):
// remove every asset record of the six brands so the library can be refilled cleanly.
// Shared creative stock is not a brand asset and is never touched. Assets with
// scheduling or publication history are retired instead of deleted so that history
// survives. All affected rows are copied to backup tables first. IAM-invoke only;
// dry run unless mode:"apply".

export const RESET = "brand_media_reset_20261017";
const BRANDS = ["stashbox","elettro","solarmeister","neckermann-strom","weightlossdavie","therasbox","pianomusicsoothing","reggaeland","google-review"];
const T = {asset: `"_${RESET}_asset"`, subject: `"_${RESET}_asset_subject"`, post: `"_${RESET}_scheduled_post"`};

async function exists(client, table) {
  return Boolean((await client.query("SELECT to_regclass($1) t", [`"${table}"`])).rows[0].t);
}

export async function runBrandMediaReset(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client, committed = false;
  try {
    client = await connectDatabase();
    await client.query("BEGIN");
    await client.query('LOCK TABLE "Asset" IN SHARE ROW EXCLUSIVE MODE');
    const brands = (await client.query('SELECT "id","slug" FROM "Brand" WHERE "slug"=ANY($1::text[])', [BRANDS])).rows;
    const brandIds = brands.map(b => b.id);
    const hasPosts = await exists(client, "ScheduledPost"), hasLedger = await exists(client, "PublicationLedger");
    const historyClauses = [hasPosts && `EXISTS (SELECT 1 FROM "ScheduledPost" p WHERE p."assetId"=a."id")`,
      hasLedger && `EXISTS (SELECT 1 FROM "PublicationLedger" l WHERE l."assetId"=a."id")`].filter(Boolean);
    const history = historyClauses.length ? historyClauses.join(" OR ") : "false";
    const before = (await client.query(`SELECT b."slug", count(a."id")::int AS assets, count(a."id") FILTER (WHERE ${history})::int AS "withHistory"
      FROM "Brand" b LEFT JOIN "Asset" a ON a."brandId"=b."id" WHERE b."id"=ANY($1::uuid[]) GROUP BY b."slug" ORDER BY b."slug"`, [brandIds])).rows;
    const otherBefore = (await client.query('SELECT count(*)::int n FROM "Asset" WHERE NOT ("brandId"=ANY($1::uuid[]))', [brandIds])).rows[0].n;

    await client.query(`CREATE TABLE IF NOT EXISTS ${T.asset} AS SELECT * FROM "Asset" WITH NO DATA`);
    await client.query(`INSERT INTO ${T.asset} SELECT a.* FROM "Asset" a WHERE a."brandId"=ANY($1::uuid[])
      AND NOT EXISTS (SELECT 1 FROM ${T.asset} s WHERE s."id"=a."id")`, [brandIds]);
    if (await exists(client, "AssetSubject")) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${T.subject} AS SELECT * FROM "AssetSubject" WITH NO DATA`);
      await client.query(`INSERT INTO ${T.subject} SELECT x.* FROM "AssetSubject" x JOIN "Asset" a ON a."id"=x."assetId" WHERE a."brandId"=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM ${T.subject} s WHERE s."assetId"=x."assetId" AND s."subjectId"=x."subjectId")`, [brandIds]);
    }
    if (hasPosts) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${T.post} AS SELECT * FROM "ScheduledPost" WITH NO DATA`);
      await client.query(`INSERT INTO ${T.post} SELECT p.* FROM "ScheduledPost" p JOIN "Asset" a ON a."id"=p."assetId" WHERE a."brandId"=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM ${T.post} s WHERE s."id"=p."id")`, [brandIds]);
    }

    const retired = await client.query(`UPDATE "Asset" a SET "retiredAt"=COALESCE("retiredAt",CURRENT_TIMESTAMP),"ingestStatus"='source_missing',"updatedAt"=CURRENT_TIMESTAMP
      WHERE a."brandId"=ANY($1::uuid[]) AND (${history}) RETURNING "id"`, [brandIds]);
    const deleted = await client.query(`DELETE FROM "Asset" a WHERE a."brandId"=ANY($1::uuid[]) AND NOT (${history}) RETURNING "id"`, [brandIds]);

    const left = (await client.query(`SELECT count(*)::int n FROM "Asset" WHERE "brandId"=ANY($1::uuid[]) AND "retiredAt" IS NULL`, [brandIds])).rows[0].n;
    const otherAfter = (await client.query('SELECT count(*)::int n FROM "Asset" WHERE NOT ("brandId"=ANY($1::uuid[]))', [brandIds])).rows[0].n;
    if (left) throw new Error(`${left} active brand assets remain`);
    if (otherAfter !== otherBefore) throw new Error("non-brand assets changed; aborting");
    const backedUp = (await client.query(`SELECT count(*)::int n FROM ${T.asset}`)).rows[0].n;

    const result = {mode, before, deleted: deleted.rowCount, retiredWithHistory: retired.rowCount, backedUp,
      otherAssetsUnchanged: otherAfter, backupTables: Object.values(T)};
    if (mode !== "apply") { await client.query("ROLLBACK"); return json(200, {ok: true, note: "Dry run rolled back; nothing changed", ...result}); }
    await client.query("COMMIT"); committed = true;
    console.info(`[${RESET}] applied`, JSON.stringify({deleted: deleted.rowCount, retired: retired.rowCount}));
    return json(200, {ok: true, ...result});
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    console.error(`[${RESET}] failed`, error);
    return json(500, {ok: false, mode, error: error instanceof Error ? error.message : "Reset failed; rolled back"});
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
