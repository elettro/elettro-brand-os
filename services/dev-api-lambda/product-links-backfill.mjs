// Point already-planned posts at their product page (DEV, 2026-11-06). IAM-invoke only; dry run unless mode:"apply".
//   action "backfill-product-links-20261106": { brandSlugs?: ["stashbox","solarmeister"], mode, limit?, sampleLimit? }
// For each planned / approved / paused post whose asset carries a Shopify product handle (Stashbox `product:<handle>`,
// SolarMeister `produkt-<handle>` + `product-link`), the brand's store-root address in the caption (and in
// scoreBreakdown.copy.primaryLink) becomes <store>/products/<handle>. Posts with no handle keep the store root.
// Never touches published/failed/publishing posts, hand-written posts, Google Business Profile posts, or a caption that
// would no longer fit its network's length limit.
import {productUrlFromTags, captionFits} from "./copywriter.mjs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure: the new caption/primaryLink for one post, or a reason it stays as is. */
export function relinkPost({destination, caption, primaryLink, tags, links}) {
  const productUrl = productUrlFromTags(tags, links);
  if (!productUrl) return {skip: "no-product-handle"};
  const roots = [...new Set([links.merchStore, links.site].filter(Boolean).map((r) => r.replace(/\/+$/, "")))];
  let nextCaption = caption || "";
  let captionChanged = false;
  for (const root of roots) {
    // The bare store address only: not a longer path, and not the start of another domain.
    const re = new RegExp(`${escapeRe(root)}(?![A-Za-z0-9_/-])(?!\\.[A-Za-z0-9])`, "g");
    const replaced = nextCaption.replace(re, productUrl);
    if (replaced !== nextCaption) { nextCaption = replaced; captionChanged = true; }
  }
  const linkIsRoot = roots.includes(String(primaryLink || "").replace(/\/+$/, ""));
  if (!captionChanged && !linkIsRoot) return {skip: "already-specific-or-no-link"};
  if (captionChanged && !captionFits(destination, nextCaption)) return {skip: "caption-too-long", productUrl};
  return {productUrl, caption: captionChanged ? nextCaption : caption, captionChanged, linkChanged: linkIsRoot};
}

export async function runBackfillProductLinks(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const brandSlugs = Array.isArray(event.brandSlugs) && event.brandSlugs.length ? event.brandSlugs.map(String) : ["stashbox", "solarmeister"];
  const limit = Math.min(Math.max(Number(event.limit) || 2000, 1), 5000);
  const sampleLimit = Math.min(Math.max(Number(event.sampleLimit) || 10, 0), 50);
  let client;
  try {
    client = await connectDatabase();
    const report = [];
    for (const brandSlug of brandSlugs) {
      const brand = (await client.query('SELECT "id","settings" FROM "Brand" WHERE "slug"=$1 AND "status"=\'active\' LIMIT 1', [brandSlug])).rows[0];
      if (!brand) { report.push({brandSlug, error: "Active brand not found"}); continue; }
      const links = brand.settings?.planner?.links || {};
      if (!links.merchStore && !links.site) { report.push({brandSlug, error: "Brand has no store/site link in planner settings"}); continue; }
      const rows = (await client.query(
        `SELECT sp."id", sp."status", sp."generatedCaption" AS "caption", sp."scoreBreakdown" AS "sb", sa."destination", a."tags"
           FROM "ScheduledPost" sp
           JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
           JOIN "Asset" a ON a."id" = sp."assetId"
          WHERE sp."brandId" = $1 AND sp."status" IN ('planned','approved','paused')
            AND sa."destination" <> 'gmb' AND sp."scoreBreakdown"->'custom' IS NULL
          ORDER BY sp."scheduledFor" LIMIT $2`, [brand.id, limit])).rows;
      const counts = {scanned: rows.length, relinked: 0, "no-product-handle": 0, "already-specific-or-no-link": 0, "caption-too-long": 0};
      const samples = [];
      for (const row of rows) {
        const r = relinkPost({destination: row.destination, caption: row.caption, primaryLink: row.sb?.copy?.primaryLink, tags: row.tags, links});
        if (r.skip) { counts[r.skip] += 1; continue; }
        counts.relinked += 1;
        if (samples.length < sampleLimit) samples.push({id: row.id, destination: row.destination, status: row.status, from: row.sb?.copy?.primaryLink || null, to: r.productUrl});
        if (mode === "apply") {
          const nextSb = row.sb?.copy && r.linkChanged ? {...row.sb, copy: {...row.sb.copy, primaryLink: r.productUrl}} : row.sb;
          await client.query(
            `UPDATE "ScheduledPost" SET "generatedCaption"=$2, "scoreBreakdown"=$3::jsonb, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status" IN ('planned','approved','paused')`,
            [row.id, r.caption, JSON.stringify(nextSb)]);
        }
      }
      report.push({brandSlug, counts, samples});
    }
    return json(200, {ok: true, mode, applied: mode === "apply", report});
  } catch (error) {
    console.error("[product-links-backfill] failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
