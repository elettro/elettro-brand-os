/**
 * Time tests switch (Dean, 2026-11-08: Stashbox, East Coast time, 80% in the normal window / 20% in 6-9 am and 9 pm-midnight,
 * YouTube, Instagram and Facebook first). Sets ONLY `Brand.settings.planner.timeTests`; everything else in the planner block stays
 * as stored. IAM-only, dry run unless mode is "apply". Takes effect at the next Plan (planner-v2 applyTimeTests).
 */
export const DEFAULT_TIME_TESTS = {
  enabled: true, share: 0.2, destinations: ["youtube", "instagram", "facebook"],
  bands: [{ from: "06:00", to: "09:00" }, { from: "21:00", to: "23:59" }]
};

export function cleanTimeTests(input) {
  const t = { ...DEFAULT_TIME_TESTS, ...(input && typeof input === "object" ? input : {}) };
  const share = Number(t.share);
  if (!Number.isFinite(share) || share < 0 || share > 0.5) throw new Error("share must be between 0 and 0.5");
  const destinations = (Array.isArray(t.destinations) ? t.destinations : []).map((d) => String(d).toLowerCase());
  const allowed = ["youtube", "instagram", "facebook", "threads", "pinterest", "tiktok", "bluesky", "mastodon", "x"];
  if (!destinations.length || destinations.some((d) => !allowed.includes(d))) throw new Error(`destinations must be from ${allowed.join(", ")} (never gmb or linkedin)`);
  const bands = (Array.isArray(t.bands) ? t.bands : []).map((b) => ({ from: String(b.from), to: String(b.to) }));
  if (!bands.length || bands.some((b) => !/^\d{2}:\d{2}$/.test(b.from) || !/^\d{2}:\d{2}$/.test(b.to) || b.from >= b.to)) throw new Error("bands must be HH:MM ranges, from before to");
  return { enabled: Boolean(t.enabled), share, destinations, bands };
}

/** { brandSlug, mode?: "apply", timeTests? } */
export async function runSetTimeTests(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const slug = String(event.brandSlug || "");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return json(400, { ok: false, error: "brandSlug is required" });
  let timeTests;
  try { timeTests = cleanTimeTests(event.timeTests); } catch (error) { return json(400, { ok: false, error: error.message }); }
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const brand = (await client.query('SELECT "id","timezone","settings" FROM "Brand" WHERE "slug" = $1 LIMIT 1', [slug])).rows[0];
    if (!brand) return json(404, { ok: false, error: "brand not found" });
    if (!brand.settings?.planner) return json(409, { ok: false, error: "brand has no planner settings" });
    const before = brand.settings.planner.timeTests || null;
    if (mode !== "apply") return json(200, { ok: true, mode, brand: slug, timezone: brand.timezone, before, after: timeTests });
    await client.query(
      `UPDATE "Brand" SET "settings" = jsonb_set("settings", '{planner,timeTests}', $2::jsonb), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [brand.id, JSON.stringify(timeTests)]);
    return json(200, { ok: true, mode, brand: slug, timezone: brand.timezone, before, after: timeTests });
  } catch (error) {
    console.error("[time-tests] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "failed" });
  } finally {
    if (client) await client.end?.();
  }
}
