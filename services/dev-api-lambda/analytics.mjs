/**
 * Analytics v1 (2026-11-08, design: docs/ANALYTICS-SPEC.md phase B "See", first slice). Read only.
 *
 * Counts and rankings from the PostMetric snapshots, never judgments: no "x normal", no winners, no plan changes yet (those switch on per
 * account once it has GRADE_AT on-time 7-day snapshots). Rules Dean set on 2026-11-08:
 *   - Posts are only ever compared within ONE network: a YouTube view, an Instagram view and a Pinterest impression are different things.
 *   - Each network ranks by its own main number (MAIN_METRIC); clicks are always shown beside it, and `sort: "clicks"` ranks by clicks.
 *   - A snapshot taken much later than its age bucket (the first catch-up runs) is shown as "caught up" and never counts toward grading.
 * Reached through the planner-review route as action "analytics" (brand-scoped, connect key), so no new API route is needed.
 */

import { addDaysToYmd, eligibleOn, resolvePlannerSettings, sectorsOf, ymdInTimeZone } from "./planner-v2.mjs";

export const MAIN_METRIC = {
  youtube: "views", instagram: "views", facebook: "views", threads: "views",
  pinterest: "views", linkedin: "views", bluesky: "likes", mastodon: "likes"
};
// What the main number is called on each network (Pinterest and LinkedIn report impressions, stored as views).
export const MAIN_LABEL = {
  youtube: "views", instagram: "views", facebook: "views", threads: "views",
  pinterest: "impressions", linkedin: "impressions", bluesky: "likes", mastodon: "favourites"
};
const BUCKET_HOURS = { "1h": 1, "24h": 24, "7d": 168, "30d": 720 };
export const GRADE_AT = 30;
const HOUR = 3600000;
const PERIODS = [7, 28, 90];
const TIME_BANDS = [[9, 12, "9 am – noon"], [12, 15, "noon – 3 pm"], [15, 18, "3 pm – 6 pm"], [18, 21, "6 pm – 9 pm"]];

const num = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** On time = taken within 1.5x the bucket's age plus 2 hours (a 7d snapshot by day 10.5). Late ones come from the first catch-up runs. */
export function isOnTime(bucket, publishedAt, capturedAt) {
  const hours = BUCKET_HOURS[bucket];
  const age = (Date.parse(capturedAt) - Date.parse(publishedAt)) / HOUR;
  return Boolean(hours) && Number.isFinite(age) && age >= 0 && age <= hours * 1.5 + 2;
}

export function median(values) {
  const list = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function pillarLabel(slug) {
  if (!slug) return "No pillar";
  return String(slug).replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Local hour of a UTC time in a timezone. */
function localHour(iso, timeZone) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso));
  return Number(h) % 24;
}

/** One post row from SQL into the shape the page needs. */
export function shapePost(row) {
  const measured = Boolean(row.ageBucket);
  const main = MAIN_METRIC[row.destination] || "views";
  const metrics = {
    views: num(row.views), reach: num(row.reach), likes: num(row.likes), comments: num(row.comments), shares: num(row.shares),
    saves: num(row.saves), clicks: num(row.linkClicks), watchTimeSeconds: num(row.watchTimeSeconds), avgViewSeconds: num(row.avgViewDurationSeconds)
  };
  const takenAfterHours = measured ? Math.round((Date.parse(row.capturedAt) - Date.parse(row.publishedAt)) / 360000) / 10 : null;
  return {
    id: row.id, destination: row.destination, placement: row.placement, account: row.accountName || null,
    title: row.title || null, publishedAt: new Date(row.publishedAt).toISOString(), url: row.externalUrl || null,
    pillar: row.sector || null, measured, story: row.placement === "story",
    bucket: row.ageBucket || null, takenAfterHours, onTime: measured ? isOnTime(row.ageBucket, row.publishedAt, row.capturedAt) : null,
    main: metrics[main] ?? null, metrics,
    why: row.breakdown ? { score: num(row.score), exploration: Boolean(row.exploration), breakdown: row.breakdown } : null
  };
}

/** Everything the page shows, from the post rows and the per-account readiness rows. Pure, so it is tested without a database. */
export function summarize(posts, readiness, { timeZone = "America/New_York", sort = "main", top = 10 } = {}) {
  const byNetwork = new Map();
  for (const p of posts) {
    if (!byNetwork.has(p.destination)) byNetwork.set(p.destination, []);
    byNetwork.get(p.destination).push(p);
  }
  const ready = new Map();
  for (const r of readiness) {
    const best = ready.get(r.destination);
    if (!best || r.onTime7d > best.onTime7d) ready.set(r.destination, { account: r.accountName, onTime7d: Number(r.onTime7d) || 0 });
  }
  const networks = [];
  for (const [destination, list] of byNetwork) {
    const measurable = list.filter((p) => !p.story);
    const measured = measurable.filter((p) => p.measured);
    const sum = (key) => measured.reduce((n, p) => n + (p.metrics[key] ?? 0), 0);
    const has = (key) => measured.some((p) => p.metrics[key] !== null);
    const rank = (p) => (sort === "clicks" ? p.metrics.clicks ?? -1 : p.main ?? -1);
    const topPosts = [...measured].sort((a, b) => rank(b) - rank(a) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, top);
    const pillars = new Map();
    for (const p of measured) {
      const key = p.pillar || "";
      if (!pillars.has(key)) pillars.set(key, []);
      pillars.get(key).push(p.main);
    }
    const bands = TIME_BANDS.map(([from, to, label]) => {
      const values = measured.filter((p) => { const h = localHour(p.publishedAt, timeZone); return h >= from && h < to; }).map((p) => p.main);
      return { label, posts: values.length, typical: median(values) };
    });
    const r = ready.get(destination) || { account: null, onTime7d: 0 };
    networks.push({
      destination, mainLabel: MAIN_LABEL[destination] || "views",
      posts: list.length, stories: list.length - measurable.length, measured: measured.length, waiting: measurable.length - measured.length,
      total: sum(MAIN_METRIC[destination] || "views"), typical: median(measured.map((p) => p.main)),
      likes: has("likes") ? sum("likes") : null, comments: has("comments") ? sum("comments") : null, shares: has("shares") ? sum("shares") : null,
      clicks: has("clicks") ? sum("clicks") : null,
      ready: { account: r.account, onTime7d: r.onTime7d, of: GRADE_AT },
      top: topPosts,
      pillars: [...pillars.entries()].map(([slug, values]) => ({ slug: slug || null, label: pillarLabel(slug), posts: values.length, typical: median(values), trust: values.length >= 10 }))
        .sort((a, b) => (b.typical ?? -1) - (a.typical ?? -1)),
      times: bands
    });
  }
  networks.sort((a, b) => b.measured - a.measured);
  const all = posts.filter((p) => !p.story);
  return {
    totals: {
      posts: posts.length, measured: all.filter((p) => p.measured).length, waiting: all.filter((p) => !p.measured).length,
      clicks: networks.reduce((n, x) => n + (x.clicks ?? 0), 0),
      readyAccounts: readiness.filter((r) => Number(r.onTime7d) >= GRADE_AT).length, accounts: readiness.length,
      closest: [...readiness].sort((a, b) => Number(b.onTime7d) - Number(a.onTime7d))[0] || null
    },
    networks
  };
}

/** Review action "analytics": { brand, days?: 7|28|90, sort?: "main"|"clicks", summary?: true }. */
export async function brandAnalytics(client, brand, body = {}, now = new Date()) {
  const days = PERIODS.includes(Number(body.days)) ? Number(body.days) : 28;
  const sort = body.sort === "clicks" ? "clicks" : "main";
  const since = new Date(now.getTime() - days * 24 * HOUR).toISOString();
  const rows = (await client.query(
    `SELECT pl."id", pl."destination", pl."placement"::text AS "placement", pl."publishedAt", pl."externalUrl", sa."accountName",
            COALESCE(NULLIF(sp."generatedTitle", ''), NULLIF(a."title", ''), pl."assetFilenameSnapshot") AS "title",
            sp."scoreBreakdown"->>'sector' AS "sector", sp."scoreBreakdown"->'breakdown' AS "breakdown",
            sp."scoreBreakdown"->>'score' AS "score", sp."scoreBreakdown"->>'exploration' = 'true' AS "exploration",
            m."ageBucket", m."capturedAt", m."views", m."likes", m."comments", m."shares", m."reach", m."saves", m."linkClicks",
            m."watchTimeSeconds", m."avgViewDurationSeconds"
     FROM "PublicationLedger" pl
     JOIN "SocialAccount" sa ON sa."id" = pl."socialAccountId"
     LEFT JOIN "ScheduledPost" sp ON sp."id" = pl."scheduledPostId"
     LEFT JOIN "Asset" a ON a."id" = pl."assetId"
     LEFT JOIN LATERAL (
       SELECT pm.* FROM "PostMetric" pm WHERE pm."ledgerId" = pl."id"
       ORDER BY CASE pm."ageBucket" WHEN '30d' THEN 4 WHEN '7d' THEN 3 WHEN '24h' THEN 2 ELSE 1 END DESC LIMIT 1
     ) m ON TRUE
     WHERE pl."brandId" = $1 AND pl."publishedAt" >= $2
     ORDER BY pl."publishedAt" DESC
     LIMIT 3000`, [brand.id, since])).rows;
  // Grading readiness counts every on-time 7-day snapshot the account ever got, not just this period's.
  const readiness = (await client.query(
    `SELECT sa."destination", sa."accountName",
            COUNT(pm."id") FILTER (WHERE pm."capturedAt" - pl."publishedAt" <= interval '254 hours')::int AS "onTime7d"
     FROM "SocialAccount" sa
     LEFT JOIN "PublicationLedger" pl ON pl."socialAccountId" = sa."id"
     LEFT JOIN "PostMetric" pm ON pm."ledgerId" = pl."id" AND pm."ageBucket" = '7d'
     WHERE sa."brandId" = $1 AND sa."status" = 'active'
     GROUP BY sa."id", sa."destination", sa."accountName"`, [brand.id])).rows;
  const lastSnapshots = Object.fromEntries((await client.query(
    `SELECT pl."destination", MAX(pm."capturedAt") AS "at" FROM "PostMetric" pm JOIN "PublicationLedger" pl ON pl."id" = pm."ledgerId"
     WHERE pl."brandId" = $1 GROUP BY pl."destination"`, [brand.id])).rows.map((r) => [r.destination, new Date(r.at).toISOString()]));
  const shaped = rows.map(shapePost);
  const summary = summarize(shaped, readiness, { timeZone: brand.timezone || "America/New_York", sort, top: body.summary ? 1 : 10 });
  for (const n of summary.networks) n.lastSnapshotAt = lastSnapshots[n.destination] || null;
  if (body.summary) {
    for (const n of summary.networks) { delete n.pillars; delete n.times; }
    return { code: 200, body: { ok: true, brand: brand.slug, days, sort, generatedAt: now.toISOString(), lastSnapshots, ...summary } };
  }
  const settings = resolvePlannerSettings(brand.settings);
  const timeZone = brand.timezone || "America/New_York";
  const assets = (await client.query(
    `SELECT "id","tags","contentGroup","approvalStatus","eligibilityType","eligibleFrom","eligibleUntil","annualFromMmdd","annualUntilMmdd"
     FROM "Asset" WHERE "brandId" = $1 AND "ingestStatus" = 'ready' AND "retiredAt" IS NULL`, [brand.id])).rows;
  const lastUsed = new Map((await client.query(
    `SELECT "assetId", MAX("publishedAt") AS "at" FROM "PublicationLedger" WHERE "brandId" = $1 AND "assetId" IS NOT NULL GROUP BY "assetId"`,
    [brand.id])).rows.map((r) => [r.assetId, new Date(r.at).toISOString().slice(0, 10)]));
  return { code: 200, body: {
    ok: true, brand: brand.slug, days, sort, generatedAt: now.toISOString(), lastSnapshots, ...summary,
    pillarMix: pillarMix(settings.sectors, shaped),
    pool: poolHealth(assets, lastUsed, settings, ymdInTimeZone(now, timeZone))
  } };
}

/** Planned share per pillar (planner settings) next to the share actually published in the period (posts the planner placed in a pillar). */
export function pillarMix(sectors, posts) {
  const placed = posts.filter((p) => p.pillar && !p.story);
  const counts = new Map();
  for (const p of placed) counts.set(p.pillar, (counts.get(p.pillar) || 0) + 1);
  const total = placed.length;
  const rows = (sectors || []).map((sec) => ({
    slug: sec.slug, label: pillarLabel(sec.slug), target: Math.round((Number(sec.share) || 0) * 100),
    actual: total ? Math.round(((counts.get(sec.slug) || 0) / total) * 100) : null, posts: counts.get(sec.slug) || 0
  }));
  // A pillar posts were placed in that is no longer in the settings still shows, with no target.
  for (const [slug, n] of counts) if (!rows.some((r) => r.slug === slug)) rows.push({ slug, label: pillarLabel(slug), target: null, actual: Math.round((n / total) * 100), posts: n });
  return { posts: total, rows };
}

/** Next date (on or after today, within `days`) an asset becomes eligible, or null when it already is or never will be in that time. */
export function opensWithin(asset, today, days) {
  if (eligibleOn(asset, today)) return null;
  for (let i = 1; i <= days; i++) {
    const ymd = addDaysToYmd(today, i);
    if (eligibleOn(asset, ymd)) return ymd;
  }
  return null;
}

/**
 * What the planner can use, per pillar: ready now, resting (used within the asset cooldown) and when the first resting one is free again.
 * "Low" when fewer ready than max(minPoolForSector, 5). Plus seasonal windows opening in the next `days` days and how many of their
 * assets still wait for approval. From the planner's own data; no analytics involved.
 */
export function poolHealth(assets, lastUsed, settings, today, days = 45) {
  const cooldown = Number(settings.cooldowns?.assetDays) || 30;
  const low = Math.max(Number(settings.minPoolForSector) || 0, 5);
  const bySector = new Map((settings.sectors || []).map((sec) => [sec.slug, { ready: 0, resting: 0, nextFree: null }]));
  const windows = new Map();
  for (const a of assets) {
    if (a.approvalStatus === "approved" && eligibleOn(a, today)) {
      const used = lastUsed.get(a.id);
      const free = used ? addDaysToYmd(String(used).slice(0, 10), cooldown) : null;
      for (const slug of sectorsOf(a, settings)) {
        const row = bySector.get(slug);
        if (!row) continue;
        if (free && free > today) { row.resting += 1; if (!row.nextFree || free < row.nextFree) row.nextFree = free; } else row.ready += 1;
      }
    }
    const opens = opensWithin(a, today, days);
    if (opens) {
      if (!windows.has(opens)) windows.set(opens, { opens, approved: 0, waiting: 0 });
      windows.get(opens)[a.approvalStatus === "approved" ? "approved" : "waiting"] += 1;
    }
  }
  return {
    cooldownDays: cooldown,
    pillars: [...bySector.entries()].map(([slug, r]) => ({ slug, label: pillarLabel(slug), ...r, low: r.ready < low })),
    windows: [...windows.values()].sort((a, b) => a.opens.localeCompare(b.opens))
  };
}
