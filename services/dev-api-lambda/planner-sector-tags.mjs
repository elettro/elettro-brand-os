// Add one match tag to one planner sector of one brand (DEV, 2026-11-03). IAM-invoke only; dry run unless mode:"apply".
//   action "add-sector-match-tag-20261103": { brandSlug, sector, tag, mode }
// Edits only Brand.settings.planner.sectors[<sector>].match.tagsAny (adds the tag if missing); every other setting is
// left exactly as stored, unlike configure-planner-brand, which replaces the whole planner block.

export async function runAddSectorMatchTag(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const brandSlug = String(event.brandSlug || "").trim();
  const sector = String(event.sector || "").trim();
  const tag = String(event.tag || "").trim().toLowerCase().slice(0, 100);
  if (!brandSlug || !sector || !tag) return json(400, {ok: false, error: "brandSlug, sector and tag are required"});
  let client;
  try {
    client = await connectDatabase();
    const brand = (await client.query('SELECT "id","settings" FROM "Brand" WHERE "slug"=$1 AND "status"=\'active\' LIMIT 1', [brandSlug])).rows[0];
    if (!brand) return json(404, {ok: false, error: "Active brand not found"});
    const sectors = brand.settings?.planner?.sectors;
    if (!Array.isArray(sectors)) return json(409, {ok: false, error: "Brand has no planner sectors"});
    const target = sectors.find((s) => s?.slug === sector);
    if (!target) return json(404, {ok: false, error: "Sector not found", sectors: sectors.map((s) => s?.slug)});
    const before = Array.isArray(target.match?.tagsAny) ? target.match.tagsAny : [];
    if (before.map((t) => String(t).toLowerCase()).includes(tag)) return json(200, {ok: true, mode, changed: false, tagsAny: before});
    const next = sectors.map((s) => s === target ? {...s, match: {...(s.match || {}), tagsAny: [...before, tag]}} : s);
    if (mode === "apply") await client.query(
      `UPDATE "Brand" SET "settings"=jsonb_set("settings",'{planner,sectors}',$2::jsonb,false),"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [brand.id, JSON.stringify(next)]);
    return json(200, {ok: true, mode, changed: mode === "apply", wouldChange: true, brandSlug, sector, before, after: [...before, tag]});
  } catch (error) {
    console.error("[planner-sector-tags] failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
