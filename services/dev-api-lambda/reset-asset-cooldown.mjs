// IAM-only: free assets from the planner's cooldown for one brand + destination, by removing what the planner counts as "used".
// { brand, destination, filenames?: string[], mode?: "apply" }  — dry run unless mode is "apply".
// Deletes the PublicationLedger rows (and their PostMetric snapshots, by cascade) and every ScheduledPost for those assets on that
// destination, in any status. Without `filenames` it takes every asset the brand has used on that destination.
export async function runResetAssetCooldown(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const brand = String(event.brand || "").trim();
  const destination = String(event.destination || "").trim();
  if (!brand || !destination) return json(400, { ok: false, error: "brand and destination are required" });
  const filenames = Array.isArray(event.filenames) && event.filenames.length ? event.filenames.map(String) : null;
  const apply = event.mode === "apply";
  let client;
  try {
    client = await connectDatabase();
    await client.query("BEGIN");
    const scope = `FROM "SocialAccount" sa JOIN "Brand" b ON b."id" = sa."brandId" WHERE b."slug" = $1 AND sa."destination" = $2`;
    const ids = (await client.query(`SELECT sa."id" ${scope}`, [brand, destination])).rows.map((r) => r.id);
    if (!ids.length) { await client.query("ROLLBACK"); return json(404, { ok: false, error: "No such brand/destination account" }); }
    const ledger = (await client.query(
      `SELECT pl."id", a."filename", pl."publishedAt", pl."externalUrl" FROM "PublicationLedger" pl JOIN "Asset" a ON a."id" = pl."assetId"
       WHERE pl."socialAccountId" = ANY($1::uuid[]) AND ($2::text[] IS NULL OR a."filename" = ANY($2::text[])) ORDER BY pl."publishedAt"`, [ids, filenames])).rows;
    const scheduled = (await client.query(
      `SELECT sp."id", sp."status", sp."scheduledFor", a."filename" FROM "ScheduledPost" sp JOIN "Asset" a ON a."id" = sp."assetId"
       WHERE sp."socialAccountId" = ANY($1::uuid[]) AND ($2::text[] IS NULL OR a."filename" = ANY($2::text[])) ORDER BY sp."scheduledFor"`, [ids, filenames])).rows;
    if (!apply) { await client.query("ROLLBACK"); return json(200, { ok: true, mode: "dry-run", ledger, scheduled }); }
    const delLedger = (await client.query(`DELETE FROM "PublicationLedger" WHERE "id" = ANY($1::uuid[])`, [ledger.map((r) => r.id)])).rowCount;
    const delScheduled = (await client.query(`DELETE FROM "ScheduledPost" WHERE "id" = ANY($1::uuid[])`, [scheduled.map((r) => r.id)])).rowCount;
    await client.query("COMMIT");
    return json(200, { ok: true, mode: "apply", deletedLedger: delLedger, deletedScheduled: delScheduled });
  } catch (error) {
    try { await client?.query("ROLLBACK"); } catch {}
    console.error("[reset-asset-cooldown] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "reset failed" });
  } finally {
    if (client) await client.end?.();
  }
}
