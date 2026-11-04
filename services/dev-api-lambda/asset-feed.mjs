// Asset feed for the elettro.com/dash "ready to post" section: how many approved, ready images and videos each
// brand holds, and how many were added per day. Public GET /status/assets (counts and dates only, no secrets).
// "Ready to post" = approvalStatus approved + ingestStatus ready + not retired (same test the planner pool and
// asset-tagging use). A day is the New York day of firstApprovedAt (createdAt when it was never stamped).
import { LIBRARY_SLUG } from "./shared-audio-library.mjs";

const CACHE_MS = 60_000;
export const DAYS = 30;
const TZ = "America/New_York";
// Both timestamps are "timestamp without time zone" holding UTC: tag UTC first, then convert, or days roll over at 7 PM.
export const ADDED_SQL = `(COALESCE(a."firstApprovedAt", a."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}'`;
const READY = `a."approvalStatus" = 'approved' AND a."ingestStatus" = 'ready' AND a."retiredAt" IS NULL AND a."kind" IN ('image','video','carousel')`;
const media = (kind) => (kind === "video" ? "videos" : "images"); // a carousel is a set of images
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
let cache = null;

// Pure: rows in, feed out.
export function buildAssetFeed({ brands, totals, added, now = Date.now() }) {
  const lib = new Set(brands.filter((b) => b.slug === LIBRARY_SLUG).map((b) => b.id));
  const byBrand = new Map(brands.filter((b) => !lib.has(b.id)).map((b) => [b.id, { slug: b.slug, name: b.name, images: 0, videos: 0, total: 0 }]));
  const all = { images: 0, videos: 0, total: 0 };
  for (const r of totals) {
    const b = byBrand.get(r.brandId); if (!b) continue;
    const m = media(r.kind);
    for (const o of [b, all]) { o[m] += r.n; o.total += r.n; }
  }
  // Last DAYS New York days ending today, zero-filled, oldest first. Step by calendar date so DST can't skip a day.
  const [y, mo, dd] = dayKey(now).split("-").map(Number);
  const perDay = new Map();
  for (const r of added) {
    if (!byBrand.has(r.brandId)) continue;
    const d = String(r.d).slice(0, 10), o = perDay.get(d) || { images: 0, videos: 0, byBrand: {} };
    o[media(r.kind)] += r.n; o.byBrand[byBrand.get(r.brandId).slug] = (o.byBrand[byBrand.get(r.brandId).slug] || 0) + r.n;
    perDay.set(d, o);
  }
  const days = [];
  const windowStart = new Date(Date.UTC(y, mo - 1, dd - (DAYS - 1))).toISOString().slice(0, 10);
  const windowAdded = [...perDay.entries()].filter(([d]) => d >= windowStart).reduce((s, [, o]) => s + o.images + o.videos, 0);
  let cum = all.total - windowAdded; // total on the morning of day one
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, mo - 1, dd - i)).toISOString().slice(0, 10), o = perDay.get(d) || { images: 0, videos: 0, byBrand: {} };
    cum += o.images + o.videos;
    days.push({ d, images: o.images, videos: o.videos, total: cum, byBrand: o.byBrand });
  }
  return { ok: true, generatedAt: new Date(now).toISOString(), refreshSeconds: CACHE_MS / 1000, total: all,
    days, brands: [...byBrand.values()].sort((a, z) => z.total - a.total || a.name.localeCompare(z.name)) };
}

export async function assetFeed(connectDatabase, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_MS) return cache.body;
  const client = await connectDatabase();
  try {
    const brands = (await client.query(`SELECT "id", "slug", "name" FROM "Brand" WHERE "status" = 'active' ORDER BY "name"`)).rows;
    const totals = (await client.query(`SELECT a."brandId", a."kind"::text AS kind, COUNT(*)::int AS n FROM "Asset" a WHERE ${READY} GROUP BY 1, 2`)).rows;
    const added = (await client.query(
      `SELECT a."brandId", a."kind"::text AS kind, to_char(${ADDED_SQL}, 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
         FROM "Asset" a WHERE ${READY} GROUP BY 1, 2, 3`)).rows;
    const body = buildAssetFeed({ brands, totals, added, now });
    cache = { at: now, body };
    return body;
  } finally {
    try { await client.end(); } catch {}
  }
}

export async function handleAssetFeed(connectDatabase, respond) {
  try {
    return respond(200, await assetFeed(connectDatabase));
  } catch (error) {
    console.error("[asset-feed] failed", error);
    return respond(500, { ok: false, error: "Asset feed unavailable" });
  }
}
