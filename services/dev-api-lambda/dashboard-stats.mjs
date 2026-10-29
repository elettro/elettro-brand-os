// Dashboard stats for the web app's main page.
//   POST /planner (web, connect key) action "stats": { brandSlug: "all" | <slug> }
// One row per network + placement (the formats in publishing-formats.mjs): how many approved assets could be
// posted there, how many approved posts are scheduled, and how many have gone out today / this week / this month / ever.
import { PUBLISHING_FORMATS, FORMAT_DESTINATIONS } from "./publishing-formats.mjs";
import { addDaysToYmd, eligibleOn, localDateTimeToUtc, poolRejection, resolvePlannerSettings, weekdayOfYmd, ymdInTimeZone } from "./planner-v2.mjs";
import { withClient } from "./planner-v2-db.mjs";

const NETWORK_LABELS = {
  instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", tiktok: "TikTok", threads: "Threads", bluesky: "Bluesky",
  pinterest: "Pinterest", linkedin: "LinkedIn", x: "X", gmb: "Google Business Profile"
};
const COUNTERS = ["possible", "scheduled", "awaiting", "failed", "today", "week", "month", "total"];
const blank = () => Object.fromEntries(COUNTERS.map((c) => [c, 0]));

/** Start of today, this Monday-first week, and this month in a brand's time zone, as UTC instants. */
export function periodStarts(timeZone, now = new Date()) {
  const today = ymdInTimeZone(now, timeZone);
  const sinceMonday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayOfYmd(today));
  return {
    today: localDateTimeToUtc(today, "00:00", timeZone),
    week: localDateTimeToUtc(addDaysToYmd(today, -sinceMonday), "00:00", timeZone),
    month: localDateTimeToUtc(`${today.slice(0, 8)}01`, "00:00", timeZone)
  };
}

/** How many approved assets each placement could take, plus how many fit any placement of the network. */
export function poolCounts(assets, settings, today) {
  const byFormat = {};
  const anyByNetwork = {};
  for (const asset of assets.filter((a) => eligibleOn(a, today))) {
    for (const f of PUBLISHING_FORMATS) {
      if (poolRejection(asset, { destination: f.destination, placement: f.placement }, settings)) continue;
      const key = `${f.destination}:${f.placement}`;
      byFormat[key] = (byFormat[key] || 0) + 1;
      (anyByNetwork[f.destination] ||= new Set()).add(asset.id);
    }
  }
  return { byFormat, anyByNetwork: Object.fromEntries(Object.entries(anyByNetwork).map(([k, v]) => [k, v.size])) };
}

async function brandStats(client, brand, now) {
  const timeZone = brand.timezone || "America/New_York";
  const settings = resolvePlannerSettings(brand.settings);
  const starts = periodStarts(timeZone, now);
  const assets = (await client.query(
    `SELECT "id","kind","aspectRatioLabel","durationMs","tags","allowedDestinations","excludedDestinations",
            "eligibilityType","eligibleFrom","eligibleUntil","annualFromMmdd","annualUntilMmdd"
     FROM "Asset"
     WHERE "brandId" = $1 AND "approvalStatus" = 'approved' AND "ingestStatus" = 'ready' AND "retiredAt" IS NULL
       AND ("sourcePath" IS NOT NULL OR "sourceUrl" IS NOT NULL)`, [brand.id])).rows;
  const published = (await client.query(
    `SELECT "destination","placement",
            COUNT(*) FILTER (WHERE "publishedAt" >= $2)::int AS today,
            COUNT(*) FILTER (WHERE "publishedAt" >= $3)::int AS week,
            COUNT(*) FILTER (WHERE "publishedAt" >= $4)::int AS month,
            COUNT(*)::int AS total
     FROM "PublicationLedger" WHERE "brandId" = $1 GROUP BY "destination","placement"`,
    [brand.id, starts.today, starts.week, starts.month])).rows;
  const queued = (await client.query(
    `SELECT sa."destination", sp."placement",
            COUNT(*) FILTER (WHERE sp."status" IN ('approved','queued','publishing','processing') AND sp."scheduledFor" >= $2)::int AS scheduled,
            COUNT(*) FILTER (WHERE sp."status" = 'planned' AND sp."scheduledFor" >= $2)::int AS awaiting,
            COUNT(*) FILTER (WHERE sp."status" IN ('failed','missed') AND sp."scheduledFor" >= $3)::int AS failed
     FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
     WHERE sp."brandId" = $1 GROUP BY sa."destination", sp."placement"`,
    [brand.id, now, starts.month])).rows;
  const accounts = (await client.query(
    `SELECT DISTINCT "destination" FROM "SocialAccount"
     WHERE "brandId" = $1 AND "status" = 'active' AND "externalAccountId" IS NOT NULL`, [brand.id])).rows;

  const pool = poolCounts(assets, settings, ymdInTimeZone(now, timeZone));
  const rows = {};
  for (const f of PUBLISHING_FORMATS) {
    const key = `${f.destination}:${f.placement}`;
    rows[key] = { ...blank(), possible: pool.byFormat[key] || 0 };
  }
  for (const r of published) if (rows[`${r.destination}:${r.placement}`]) Object.assign(rows[`${r.destination}:${r.placement}`], { today: r.today, week: r.week, month: r.month, total: r.total });
  for (const r of queued) if (rows[`${r.destination}:${r.placement}`]) Object.assign(rows[`${r.destination}:${r.placement}`], { scheduled: r.scheduled, awaiting: r.awaiting, failed: r.failed });
  return { rows, anyByNetwork: pool.anyByNetwork, connected: new Set(accounts.map((a) => a.destination)) };
}

/** Sum per-brand results into one card per network. */
export function combine(perBrand) {
  return FORMAT_DESTINATIONS.map((destination) => {
    const formats = PUBLISHING_FORMATS.filter((f) => f.destination === destination).map((f) => {
      const row = blank();
      for (const b of perBrand) for (const c of COUNTERS) row[c] += b.rows[`${destination}:${f.placement}`]?.[c] || 0;
      return { placement: f.placement, label: f.label, status: f.status, note: f.note || null, ...row };
    });
    const totals = blank();
    for (const f of formats) for (const c of COUNTERS) if (c !== "possible") totals[c] += f[c];
    totals.possible = perBrand.reduce((n, b) => n + (b.anyByNetwork[destination] || 0), 0);
    return {
      destination, label: NETWORK_LABELS[destination] || destination,
      connectedBrands: perBrand.filter((b) => b.connected.has(destination)).length, totals, formats
    };
  });
}

export async function dashboardStats(body, connectDatabase, json, now = new Date()) {
  return withClient(connectDatabase, json, "dashboard-stats", async (client) => {
    const brands = (await client.query(
      `SELECT "id","slug","name","timezone","settings" FROM "Brand" WHERE "status" = 'active' ORDER BY "name"`)).rows;
    const scope = String(body.brandSlug || "all").toLowerCase();
    const picked = scope === "all" ? brands : brands.filter((b) => b.slug === scope);
    if (!picked.length) return json(404, { ok: false, error: "Active brand not found" });
    const perBrand = [];
    for (const brand of picked) perBrand.push(await brandStats(client, brand, now));
    return json(200, {
      ok: true, scope, generatedAt: now.toISOString(),
      brands: brands.map(({ slug, name }) => ({ slug, name })),
      networks: combine(perBrand)
    });
  });
}
