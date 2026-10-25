// Post race feed for the elettro.com/dash "1000 posts" race: how many posts each brand and each network
// has published through Elettro OS, and when each one crossed the finish line. Public GET /status/posts
// (counts and timestamps only, no secrets). Source of truth is PublicationLedger; ScheduledPost
// supplies the "in the pipe" ghost trail.
import { LIBRARY_SLUG } from "./shared-audio-library.mjs";

export const GOAL = 1000;
export const RACE_START = process.env.POST_RACE_START || "2026-10-25T00:00:00-04:00";
const CACHE_MS = 60_000;
const PIPELINE = ["approved", "queued", "publishing", "processing"];

let cache = null;

const iso = (v) => (v ? new Date(v).toISOString() : null);

// Pure: rows in, race out. Keeps the SQL thin and the scoring testable.
export function buildRace({ published, scheduled, finishes, brands, now = Date.now() }) {
  const lib = new Set(brands.filter((b) => b.slug === LIBRARY_SLUG).map((b) => b.id));
  const byBrand = new Map(brands.filter((b) => !lib.has(b.id)).map((b) => [b.id, { slug: b.slug, name: b.name, published: 0, scheduled: 0, firstAt: null, lastAt: null, byDestination: {} }]));
  const byDest = new Map();
  const total = { published: 0, scheduled: 0, firstAt: null, lastAt: null };
  const touch = (o, first, last) => {
    if (first && (!o.firstAt || first < o.firstAt)) o.firstAt = first;
    if (last && (!o.lastAt || last > o.lastAt)) o.lastAt = last;
  };
  for (const r of published) {
    const b = byBrand.get(r.brandId); if (!b) continue;
    const d = byDest.get(r.destination) || { destination: r.destination, published: 0, scheduled: 0, firstAt: null, lastAt: null };
    byDest.set(r.destination, d);
    const first = iso(r.firstAt), last = iso(r.lastAt);
    for (const o of [b, d, total]) { o.published += r.n; touch(o, first, last); }
    b.byDestination[r.destination] = (b.byDestination[r.destination] || 0) + r.n;
  }
  for (const r of scheduled) {
    const b = byBrand.get(r.brandId); if (!b) continue;
    const d = byDest.get(r.destination) || { destination: r.destination, published: 0, scheduled: 0, firstAt: null, lastAt: null };
    byDest.set(r.destination, d);
    for (const o of [b, d, total]) o.scheduled += r.n;
  }
  const done = (key) => iso(finishes[key]);
  return {
    ok: true, generatedAt: new Date(now).toISOString(), refreshSeconds: CACHE_MS / 1000,
    goal: GOAL, raceStart: new Date(RACE_START).toISOString(),
    total: { ...total, finishedAt: done("all") },
    destinations: [...byDest.values()].map((d) => ({ ...d, finishedAt: done(`d:${d.destination}`) })),
    brands: [...byBrand.entries()].map(([id, b]) => ({ ...b, finishedAt: done(`b:${id}`) }))
  };
}

export async function postRaceFeed(connectDatabase, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_MS) return cache.body;
  const client = await connectDatabase();
  try {
    const brands = (await client.query(`SELECT "id", "slug", "name" FROM "Brand" WHERE "status" = 'active' ORDER BY "name"`)).rows;
    const published = (await client.query(
      `SELECT "brandId", "destination", COUNT(*)::int AS n, MIN("publishedAt") AS "firstAt", MAX("publishedAt") AS "lastAt"
         FROM "PublicationLedger" GROUP BY "brandId", "destination"`)).rows;
    const scheduled = (await client.query(
      `SELECT sa."brandId", sa."destination", COUNT(*)::int AS n
         FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
        WHERE sp."status" = ANY($1::text[]) GROUP BY sa."brandId", sa."destination"`, [PIPELINE])).rows;
    // When did each scope cross the line? The publishedAt of its GOAL-th post, only looked up once it has one.
    const finishes = {};
    const nth = async (key, where, params) => {
      const row = (await client.query(
        `SELECT "publishedAt" FROM "PublicationLedger" ${where} ORDER BY "publishedAt" OFFSET ${GOAL - 1} LIMIT 1`, params)).rows[0];
      if (row) finishes[key] = row.publishedAt;
    };
    const sum = (rows, pick) => rows.reduce((m, r) => (m.set(pick(r), (m.get(pick(r)) || 0) + r.n), m), new Map());
    if (published.reduce((s, r) => s + r.n, 0) >= GOAL) await nth("all", "", []);
    for (const [dest, n] of sum(published, (r) => r.destination)) if (n >= GOAL) await nth(`d:${dest}`, `WHERE "destination" = $1`, [dest]);
    for (const [id, n] of sum(published, (r) => r.brandId)) if (n >= GOAL) await nth(`b:${id}`, `WHERE "brandId" = $1`, [id]);
    const body = buildRace({ published, scheduled, finishes, brands, now });
    cache = { at: now, body };
    return body;
  } finally {
    try { await client.end(); } catch {}
  }
}

export async function handlePostRace(connectDatabase, respond) {
  try {
    return respond(200, await postRaceFeed(connectDatabase));
  } catch (error) {
    console.error("[post-race] failed", error);
    return respond(500, { ok: false, error: "Post race feed unavailable" });
  }
}
