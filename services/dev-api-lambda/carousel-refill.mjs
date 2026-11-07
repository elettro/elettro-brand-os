/**
 * One-off repair (2026-11-07): carousels planned before the one-product rule (planner-v2 `carouselMates`) were filled
 * with the next-best images of the whole pillar, so a Bauhaus pint-glass carousel also showed two tees and another glass.
 *
 * IAM-only action `refill-carousel-slides-20261107` { brandSlug, mode?: "apply", pauseUnfixable?: true }:
 * for every future planned / approved / paused carousel of the brand, the slides are rebuilt from the lead image the
 * same way the planner now does (its own slide set, else the same product; a non-product lead keeps only its
 * non-product slides). Dry run unless mode is "apply". A carousel that cannot reach the format's minimum is listed as
 * `unfixable`; with pauseUnfixable it is paused (Calendar can then Remove or Resume it), otherwise left as is.
 */
import { withClient, loadBrand } from "./planner-v2-db.mjs";
import { carouselMates, eligibleOn, poolRejection, productKeyOf, slideSetOf, uniquePictures, resolvePlannerSettings } from "./planner-v2.mjs";
import { slideRange } from "./publishing-formats.mjs";

/** Pure: the new slide list for one carousel, or why it cannot be made. */
export function refillSlides({ lead, current, pool, range }) {
  if (!lead) return { ok: false, why: "lead image is gone" };
  const { how, mates } = carouselMates(lead, pool, []);
  let ids;
  if (how === "generic") {
    // A non-product lead keeps the non-product images it already had, in their order.
    const allowed = new Map(pool.map((a) => [a.id, a]));
    ids = [lead.id, ...current.filter((id) => id !== lead.id && allowed.get(id) && !productKeyOf(allowed.get(id)) && !slideSetOf(allowed.get(id)))];
  } else {
    ids = [lead.id, ...mates.map((a) => a.id)];
  }
  // Never the same picture twice (same file name filed in two places).
  const byId = new Map([lead, ...pool].map((a) => [a.id, a]));
  ids = uniquePictures(ids.map((id) => byId.get(id)).filter(Boolean)).map((a) => a.id).slice(0, range.max);
  if (ids.length < range.min) return { ok: false, how, why: `only ${ids.length} matching image(s); the minimum is ${range.min}`, ids };
  return { ok: true, how, ids };
}

export async function runCarouselRefill(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const slug = String(event.brandSlug || "");
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return json(400, { ok: false, error: "brandSlug is required" });
  return withClient(connectDatabase, json, "refill-carousel-slides", async (client) => {
    const brand = await loadBrand(client, slug);
    if (!brand) return json(404, { ok: false, error: `No active brand ${slug}` });
    const settings = resolvePlannerSettings(brand.settings);
    const assets = (await client.query(
      `SELECT "id","filename","kind","aspectRatioLabel","tags","priority","eligibilityType","eligibleFrom","eligibleUntil",
              "annualFromMmdd","annualUntilMmdd","allowedDestinations","excludedDestinations","shopifyProductId","sourcePath"
       FROM "Asset"
       WHERE "brandId" = $1 AND "approvalStatus" = 'approved' AND "ingestStatus" = 'ready' AND "retiredAt" IS NULL
         AND ("sourcePath" IS NOT NULL OR "sourceUrl" IS NOT NULL)`, [brand.id])).rows;
    const byId = new Map(assets.map((a) => [a.id, a]));
    const posts = (await client.query(
      `SELECT sp."id", sp."assetId", sp."status", sp."scheduledFor", sp."scoreBreakdown"->'slideIds' AS "slideIds", sa."destination"
       FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
       WHERE sp."brandId" = $1 AND sp."placement"::text = 'carousel' AND sp."status" IN ('planned','approved','paused')
         AND sp."scheduledFor" > CURRENT_TIMESTAMP
       ORDER BY sp."scheduledFor"`, [brand.id])).rows;

    const name = (id) => byId.get(id)?.filename || id;
    const report = [];
    for (const post of posts) {
      const current = Array.isArray(post.slideIds) ? post.slideIds.map(String) : [];
      const range = slideRange(settings, post.destination, "carousel");
      const ymd = new Date(post.scheduledFor).toISOString().slice(0, 10);
      const account = { destination: post.destination, placement: "carousel" };
      const pool = assets.filter((a) => !poolRejection(a, account, settings) && eligibleOn(a, ymd));
      const r = range ? refillSlides({ lead: byId.get(post.assetId), current, pool, range }) : { ok: false, why: "not a carousel format" };
      const unchanged = r.ok && r.ids.length === current.length && r.ids.every((id, i) => id === current[i]);
      const row = { id: post.id, destination: post.destination, status: post.status, at: post.scheduledFor, lead: name(post.assetId),
        result: !r.ok ? "unfixable" : unchanged ? "already-right" : "refilled", why: r.why || null, fill: r.how || null,
        before: current.map(name), after: r.ok ? r.ids.map(name) : null };
      report.push(row);
      if (mode !== "apply") continue;
      if (row.result === "refilled") {
        await client.query(
          `UPDATE "ScheduledPost" SET "scoreBreakdown" = COALESCE("scoreBreakdown", '{}'::jsonb)
             || jsonb_build_object('slideIds', $2::jsonb, 'carouselFill', $3::text, 'carouselRefilledAt', to_jsonb(CURRENT_TIMESTAMP)),
             "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1 AND "status" IN ('planned','approved','paused')`, [post.id, JSON.stringify(r.ids), r.how]);
      } else if (row.result === "unfixable" && event.pauseUnfixable === true && post.status !== "paused") {
        await client.query(
          `UPDATE "ScheduledPost" SET "status" = 'paused', "updatedAt" = CURRENT_TIMESTAMP
           WHERE "id" = $1 AND "status" IN ('planned','approved')`, [post.id]);
        row.paused = true;
      }
    }
    const count = (k) => report.filter((r) => r.result === k).length;
    return json(200, { ok: true, mode, brand: slug, carousels: report.length, refilled: count("refilled"), alreadyRight: count("already-right"),
      unfixable: count("unfixable"), posts: report });
  });
}
