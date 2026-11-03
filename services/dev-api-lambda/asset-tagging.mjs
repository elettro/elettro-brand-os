// Bulk asset tagging (DEV, 2026-11-03, requested by the account owner).
// IAM-invoke only. Two actions, both safe by default:
//   action "list-untagged-assets-20261103": READ ONLY. Lists ready, approved, non-retired assets whose tag list holds
//       at most `maxTags` entries (default 0), across every brand and the shared creative-assets library.
//       Params: brandSlug (omit for all), kind (default "image"), maxTags, limit (1-500, default 200), after (asset id cursor).
//   action "tag-assets-20261103": sets title/topic/tags/notes on up to 200 assets by id. Dry run unless mode:"apply".
//       Tags are MERGED with the existing ones (nothing is removed). title/topic/notes fill only EMPTY fields
//       unless overwrite:true. Never touches approval, ingest or enrichment status, and skips retired assets.

const KINDS = ["image", "video", "carousel", "audio", "document"];
const direct = (event) => !event.requestContext && !event.rawPath && !event.path;

export async function runListUntaggedAssets(event, connectDatabase, json) {
  if (!direct(event)) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const kind = KINDS.includes(event.kind) ? event.kind : "image";
  const maxTags = Math.max(0, Math.min(20, Number.isFinite(Number(event.maxTags)) ? Math.floor(Number(event.maxTags)) : 0));
  const limit = Math.max(1, Math.min(500, Number.isFinite(Number(event.limit)) ? Math.floor(Number(event.limit)) : 200));
  const brandSlug = typeof event.brandSlug === "string" && event.brandSlug ? event.brandSlug : null;
  const after = typeof event.after === "string" && /^[0-9a-f-]{36}$/i.test(event.after) ? event.after : null;
  let client;
  try {
    client = await connectDatabase();
    const where = `a."kind"=$1::"AssetKind" AND a."approvalStatus"='approved' AND a."ingestStatus"='ready' AND a."retiredAt" IS NULL
      AND COALESCE(cardinality(a."tags"),0) <= $2 AND ($3::text IS NULL OR b."slug"=$3)`;
    const counts = (await client.query(
      `SELECT b."slug", COUNT(*)::int AS "untagged" FROM "Asset" a JOIN "Brand" b ON b."id"=a."brandId"
       WHERE ${where} GROUP BY b."slug" ORDER BY b."slug"`, [kind, maxTags, brandSlug])).rows;
    const rows = (await client.query(
      `SELECT a."id", b."slug" AS "brandSlug", a."filename", a."sourcePath", a."kind", a."aspectRatioLabel", a."durationMs",
              a."contentGroup", a."title", a."topic", a."tags", a."creativeNotes",
              a."allowedDestinations", a."excludedDestinations", a."eligibilityType"
       FROM "Asset" a JOIN "Brand" b ON b."id"=a."brandId"
       WHERE ${where} AND ($4::uuid IS NULL OR a."id" > $4::uuid)
       ORDER BY a."id" LIMIT $5`, [kind, maxTags, brandSlug, after, limit])).rows;
    return json(200, {ok: true, kind, maxTags, countsByBrand: counts, returned: rows.length,
      next: rows.length === limit ? rows[rows.length - 1].id : null, assets: rows});
  } catch (error) {
    console.error("[asset-tagging] list failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "list failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : [])
  .filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim().slice(0, 100)))].slice(0, 50);

export async function runTagAssets(event, connectDatabase, json) {
  if (!direct(event)) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const overwrite = event.overwrite === true;
  const items = Array.isArray(event.items) ? event.items : [];
  if (!items.length || items.length > 200) return json(400, {ok: false, error: "items must hold 1-200 entries"});
  let client;
  try {
    client = await connectDatabase();
    const results = [];
    for (const item of items) {
      const id = String(item?.assetId || "");
      const add = cleanTags(item?.tags);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !add.length) { results.push({assetId: item?.assetId, status: "rejected"}); continue; }
      const row = (await client.query(
        'SELECT "id","tags","title","topic","creativeNotes","retiredAt","allowedDestinations" FROM "Asset" WHERE "id"=$1', [id])).rows[0];
      if (!row) { results.push({assetId: id, status: "not-found"}); continue; }
      if (row.retiredAt) { results.push({assetId: id, status: "retired"}); continue; }
      const have = Array.isArray(row.tags) ? row.tags : [];
      const seen = new Set(have.map((t) => String(t).toLowerCase()));
      const tags = [...have, ...add.filter((t) => !seen.has(t.toLowerCase()))].slice(0, 50);
      const pick = (current, next, max) => {
        const v = String(next || "").trim().slice(0, max);
        return v && (overwrite || !current) ? v : current || null;
      };
      // allowedDestinations: [] opens the asset to every network; a list restricts it to those networks.
      const wantDest = item.allowedDestinations !== undefined ? item.allowedDestinations : event.allowedDestinations;
      let destinations;
      if (wantDest !== undefined) {
        if (!Array.isArray(wantDest) || wantDest.length > 20 || wantDest.some((d) => typeof d !== "string" || !/^[a-z0-9_-]{2,30}$/i.test(d))) {
          results.push({assetId: id, status: "rejected", error: "bad allowedDestinations"}); continue;
        }
        destinations = [...new Set(wantDest.map((d) => d.toLowerCase()))];
      }
      const title = pick(row.title, item.title, 200), topic = pick(row.topic, item.topic, 200), notes = pick(row.creativeNotes, item.notes, 2000);
      if (mode === "apply") await client.query(
        'UPDATE "Asset" SET "title"=$2,"topic"=$3,"tags"=$4,"creativeNotes"=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [id, title, topic, tags, notes]);
      if (mode === "apply" && destinations) await client.query('UPDATE "Asset" SET "allowedDestinations"=$2 WHERE "id"=$1', [id, destinations]);
      results.push({assetId: id, status: mode === "apply" ? "tagged" : "would-tag", tagsAdded: tags.length - have.length, tags,
        ...(destinations ? {allowedDestinations: {before: row.allowedDestinations || [], after: destinations}} : {})});
    }
    return json(200, {ok: true, mode, overwrite, summary: results.reduce((m, r) => ({...m, [r.status]: (m[r.status] || 0) + 1}), {}), results});
  } catch (error) {
    console.error("[asset-tagging] tag failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "tagging failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
