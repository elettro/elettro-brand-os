/**
 * Performance against each account's normal (2026-11-08, step (b) groundwork; plan: Claude Doc "How results should shape next week's
 * posts", sections 3-4; spec docs/ANALYTICS-SPEC.md 4.1-4.2 and 5.4). Read only, computed on request, nothing stored.
 *
 *   normal  = median main number of ON-TIME snapshots for one account x placement x age bucket over the last 90 days (min 10 posts),
 *             else the brand's same network x placement x bucket, else none.
 *   lift    = (value + 1) / (normal + 1); kept as doublings (log2) so a 4x hit and a 0.25x flop pull equally.
 *   groups  = per account and bucket: pillar, length, time band, asset; shrunk toward normal: sum(log2 lift) / (n + K), K = 10.
 *   ready   = the account has GRADE_AT on-time 7-day snapshots; the page shows grades only for ready accounts (Dean, 2026-11-08).
 * Catch-up snapshots (taken far later than their bucket) never count: see isOnTime in analytics.mjs.
 */
import { GRADE_AT, MAIN_METRIC, isOnTime, median, pillarLabel } from "./analytics.mjs";

export const SHRINK_K = 10;
export const MIN_NORMAL_POSTS = 10;
const DAY = 864e5;
const BUCKETS = ["1h", "24h", "7d", "30d"];
const TIME_BANDS = [[9, 12, "9-12"], [12, 15, "12-15"], [15, 18, "15-18"], [18, 21, "18-21"]];

export function lengthBucket(ms) {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s <= 0) return null;
  return s < 15 ? "under 15s" : s < 30 ? "15-30s" : s < 60 ? "30-60s" : s < 180 ? "1-3 min" : "3 min+";
}

function band(iso, timeZone) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso))) % 24;
  const b = TIME_BANDS.find(([from, to]) => h >= from && h < to);
  return b ? b[2] : "outside 9-21";
}

export const log2Lift = (value, normal) => Math.log2((value + 1) / (normal + 1));
export const shrink = (logs, k = SHRINK_K) => (logs.length ? logs.reduce((a, b) => a + b, 0) / (logs.length + k) : 0);

/**
 * rows: one per snapshot { ledgerId, socialAccountId, accountName, destination, placement, publishedAt, sector, durationMs, assetId,
 * title, ageBucket, capturedAt, value (the main number) }. Pure.
 */
export function computePerformance(rows, { now = new Date(), timeZone = "America/New_York" } = {}) {
  const since = now.getTime() - 90 * DAY;
  const fair = rows.filter((r) => r.value !== null && r.value !== undefined && r.placement !== "story" && isOnTime(r.ageBucket, r.publishedAt, r.capturedAt));
  const recent = fair.filter((r) => Date.parse(r.publishedAt) >= since);
  const values = new Map();
  const push = (key, v) => { if (!values.has(key)) values.set(key, []); values.get(key).push(v); };
  for (const r of recent) {
    push(`a|${r.socialAccountId}|${r.placement}|${r.ageBucket}`, Number(r.value));
    push(`b|${r.destination}|${r.placement}|${r.ageBucket}`, Number(r.value));
  }
  const normalOf = (r) => {
    const own = values.get(`a|${r.socialAccountId}|${r.placement}|${r.ageBucket}`) || [];
    if (own.length >= MIN_NORMAL_POSTS) return { value: median(own), n: own.length, from: "account" };
    const brand = values.get(`b|${r.destination}|${r.placement}|${r.ageBucket}`) || [];
    if (brand.length >= MIN_NORMAL_POSTS) return { value: median(brand), n: brand.length, from: "brand" };
    return null;
  };
  const accounts = new Map();
  for (const r of fair) {
    const normal = normalOf(r);
    if (!normal) continue;
    if (!accounts.has(r.socialAccountId)) accounts.set(r.socialAccountId, { socialAccountId: r.socialAccountId, account: r.accountName, destination: r.destination, onTime7d: 0, normals: {}, posts: [] });
    const acc = accounts.get(r.socialAccountId);
    acc.normals[`${r.placement}@${r.ageBucket}`] = { value: normal.value, posts: normal.n, from: normal.from };
    acc.posts.push({ ledgerId: r.ledgerId, assetId: r.assetId, title: r.title, placement: r.placement, bucket: r.ageBucket, publishedAt: r.publishedAt,
      value: Number(r.value), lift: Math.round(2 ** log2Lift(Number(r.value), normal.value) * 100) / 100, log: log2Lift(Number(r.value), normal.value),
      pillar: r.sector || null, length: lengthBucket(r.durationMs), band: band(r.publishedAt, timeZone), week: new Date(Date.parse(r.publishedAt) - (new Date(r.publishedAt).getUTCDay() * DAY)).toISOString().slice(0, 10) });
  }
  for (const r of fair) if (r.ageBucket === "7d" && accounts.has(r.socialAccountId)) accounts.get(r.socialAccountId).onTime7d += 1;
  return [...accounts.values()].map((acc) => {
    const groups = [];
    for (const bucket of BUCKETS) {
      const posts = acc.posts.filter((p) => p.bucket === bucket);
      if (!posts.length) continue;
      for (const dim of ["pillar", "length", "band", "asset"]) {
        const byKey = new Map();
        for (const p of posts) {
          const key = dim === "asset" ? p.assetId : p[dim];
          if (!key) continue;
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push(p);
        }
        for (const [key, list] of byKey) {
          const logs = list.map((p) => p.log);
          const s = shrink(logs);
          groups.push({
            bucket, dim, key, label: dim === "pillar" ? pillarLabel(key) : dim === "asset" ? (list[0].title || "Untitled") : key,
            posts: list.length, weeks: new Set(list.map((p) => p.week)).size,
            lift: Math.round(2 ** s * 100) / 100, rawLift: Math.round(2 ** (logs.reduce((a, b) => a + b, 0) / logs.length) * 100) / 100
          });
        }
      }
    }
    // A candidate finding: big enough after shrinking, 10+ posts, 2+ weeks. "Holds up" (two weekly runs in a row) needs the stored
    // history that the changes PR adds; until then everything here is at most an early signal.
    const candidates = groups.filter((g) => g.dim !== "asset" && g.posts >= 10 && g.weeks >= 2 && (g.lift >= 1.25 || g.lift <= 0.8))
      .map((g) => ({ ...g, confidence: "early signal" }));
    return {
      socialAccountId: acc.socialAccountId, account: acc.account, destination: acc.destination, onTime7d: acc.onTime7d,
      ready: acc.onTime7d >= GRADE_AT, normals: acc.normals, groups: groups.sort((a, b) => b.lift - a.lift), candidates,
      posts: acc.posts.map(({ log, week, ...p }) => p)
    };
  });
}

/** Loads the brand's last 120 days of snapshots and computes. */
export async function brandPerformance(client, brand, now = new Date()) {
  const rows = (await client.query(
    `SELECT pl."id" AS "ledgerId", pl."socialAccountId", sa."accountName", pl."destination", pl."placement"::text AS "placement", pl."publishedAt",
            sp."scoreBreakdown"->>'sector' AS "sector", a."durationMs", pl."assetId",
            COALESCE(NULLIF(sp."generatedTitle", ''), NULLIF(a."title", ''), pl."assetFilenameSnapshot") AS "title",
            pm."ageBucket", pm."capturedAt", pm."views", pm."likes"
     FROM "PostMetric" pm
     JOIN "PublicationLedger" pl ON pl."id" = pm."ledgerId"
     JOIN "SocialAccount" sa ON sa."id" = pl."socialAccountId"
     LEFT JOIN "ScheduledPost" sp ON sp."id" = pl."scheduledPostId"
     LEFT JOIN "Asset" a ON a."id" = pl."assetId"
     WHERE pl."brandId" = $1 AND pl."publishedAt" >= $2`, [brand.id, new Date(now.getTime() - 120 * DAY).toISOString()])).rows;
  const shaped = rows.map((r) => ({ ...r, publishedAt: new Date(r.publishedAt).toISOString(), capturedAt: new Date(r.capturedAt).toISOString(),
    value: (MAIN_METRIC[r.destination] || "views") === "likes" ? r.likes : r.views }));
  return computePerformance(shaped, { now, timeZone: brand.timezone || "America/New_York" });
}

/** IAM-only { brandSlug, details? }: the computed normals, groups and candidate findings for one brand, so they can be checked by hand. */
export async function runPerformance(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const slug = String(event.brandSlug || "");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return json(400, { ok: false, error: "brandSlug is required" });
  let client;
  try {
    client = await connectDatabase();
    const brand = (await client.query('SELECT "id","slug","timezone" FROM "Brand" WHERE "slug" = $1 LIMIT 1', [slug])).rows[0];
    if (!brand) return json(404, { ok: false, error: "brand not found" });
    const accounts = await brandPerformance(client, brand);
    if (!event.details) for (const a of accounts) { delete a.posts; a.groups = a.groups.slice(0, 12); }
    return json(200, { ok: true, brand: slug, accounts });
  } catch (error) {
    console.error("[performance] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "failed" });
  } finally {
    if (client) await client.end?.();
  }
}
