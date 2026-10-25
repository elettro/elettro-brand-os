// The Planner page and the publishing loop around Planner V2.
//   POST /planner (web, connect key): view | stats | set-cadence | approve-week | request-replan
//   IAM-only (the YouTube upload worker calls these every 15 minutes):
//     planner-tick     plan the next unplanned week, or a week the page asked to re-plan (one per call)
//     claim-due-posts  hand out approved posts whose time has come, marked 'publishing'
//     finish-post      record the outcome: 'published' + a PublicationLedger row, or 'failed'
import { withClient, loadBrand, weekWindow, runPlanWeek, approvePlannerWeek } from "./planner-v2-db.mjs";
import { addDaysToYmd, brandLanguage, isSynthetic, languageOf, resolvePlannerSettings, ymdInTimeZone } from "./planner-v2.mjs";
import { dashboardStats } from "./dashboard-stats.mjs";
import { keyMatches } from "./youtube-connect.mjs";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POSTS_PER_WEEK = 200;
// Weeks the tick keeps planned ahead of today, counting next week.
const WEEKS_AHEAD = 2;

async function plannerView(body, connectDatabase, json) {
  return withClient(connectDatabase, json, "planner-view", async (client) => {
    const brand = await loadBrand(client, String(body.brandSlug || ""));
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const { weekStart, from, to, timeZone } = weekWindow(brand, body.weekStart);
    const rules = (await client.query(
      `SELECT cr."id", sa."destination", sa."accountName", sa."publishingMode", sa."externalAccountId" IS NOT NULL AS "connected",
              cr."placement", cr."postsPerWeek", cr."preferredDays", cr."preferredStartTime", cr."preferredEndTime"
       FROM "CadenceRule" cr JOIN "SocialAccount" sa ON sa."id" = cr."socialAccountId"
       WHERE sa."brandId" = $1 AND sa."status" = 'active' AND cr."active" = TRUE
       ORDER BY sa."destination", cr."placement"`, [brand.id])).rows;
    const posts = (await client.query(
      `SELECT sp."id", sp."scheduledFor", sp."status", sp."placement", sa."destination", a."filename",
              sp."generatedTitle" AS "title", pl."externalUrl" AS "url", sp."scoreBreakdown"->'publish'->>'error' AS "error"
       FROM "ScheduledPost" sp
       JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
       JOIN "Asset" a ON a."id" = sp."assetId"
       LEFT JOIN "PublicationLedger" pl ON pl."scheduledPostId" = sp."id"
       WHERE sp."brandId" = $1 AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3
       ORDER BY sp."scheduledFor", sa."destination"`, [brand.id, from, to])).rows;
    return json(200, {
      ok: true, brand: brand.slug, timeZone, weekStart, rules, posts,
      replanRequested: brand.settings?.plannerRuntime?.replanWeek === weekStart
    });
  });
}

async function setCadence(body, connectDatabase, json) {
  const rules = Array.isArray(body.rules) ? body.rules : [];
  if (!rules.length || rules.some((r) => !Number.isInteger(r.postsPerWeek) || r.postsPerWeek < 0 || r.postsPerWeek > MAX_POSTS_PER_WEEK)) {
    return json(400, { ok: false, error: `rules need postsPerWeek between 0 and ${MAX_POSTS_PER_WEEK}` });
  }
  return withClient(connectDatabase, json, "set-cadence", async (client) => {
    const brand = await loadBrand(client, String(body.brandSlug || ""));
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    let updated = 0;
    for (const r of rules) {
      updated += (await client.query(
        `UPDATE "CadenceRule" cr SET "postsPerWeek" = $3, "updatedAt" = CURRENT_TIMESTAMP
         FROM "SocialAccount" sa
         WHERE cr."id"::text = $1 AND sa."id" = cr."socialAccountId" AND sa."brandId" = $2 AND cr."postsPerWeek" <> $3`,
        [String(r.id), brand.id, r.postsPerWeek])).rowCount;
    }
    return json(200, { ok: true, updated });
  });
}

// Planning a week takes longer than a web request may run, so the page leaves a note for the next tick.
async function requestReplan(body, connectDatabase, json) {
  return withClient(connectDatabase, json, "request-replan", async (client) => {
    const brand = await loadBrand(client, String(body.brandSlug || ""));
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const { weekStart } = weekWindow(brand, body.weekStart);
    await client.query(
      `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{plannerRuntime}', $2::jsonb, true),
              "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [brand.id, JSON.stringify({ replanWeek: weekStart, requestedAt: new Date().toISOString() })]);
    return json(200, { ok: true, weekStart });
  });
}

export async function handlePlannerWeb(event, body, connectDatabase, json) {
  const headers = event.headers || {};
  if (!keyMatches(headers["x-elettro-connect-key"])) return json(401, { ok: false, error: "Planner key required" });
  if (body.action === "view") return plannerView(body, connectDatabase, json);
  if (body.action === "stats") return dashboardStats(body, connectDatabase, json);
  if (body.action === "set-cadence") return setCadence(body, connectDatabase, json);
  if (body.action === "request-replan") return requestReplan(body, connectDatabase, json);
  if (body.action === "approve-week") {
    if (!YMD.test(String(body.weekStart || ""))) return json(400, { ok: false, error: "weekStart (YYYY-MM-DD) is required" });
    return approvePlannerWeek({ brandSlug: body.brandSlug, weekStart: body.weekStart }, connectDatabase, json);
  }
  return json(400, { ok: false, error: "Unknown planner action" });
}

// When a clip was recorded: the YYMMDD session date that starts its filename (261011-…), else today.
export function recordingDateOf(filename, today) {
  const m = String(filename || "").match(/^(\d{2})(\d{2})(\d{2})[-_]/);
  if (m) {
    const ymd = `20${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(ymd + "T12:00:00Z");
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd && ymd <= today) return ymd;
  }
  return today;
}

// A brand's recording location for uploads, from Brand.settings.location {latitude, longitude, description}.
export function brandLocation(settings) {
  const loc = settings && typeof settings === "object" ? settings.location : null;
  return loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
    ? { latitude: loc.latitude, longitude: loc.longitude, description: String(loc.description || "") } : null;
}

// YouTube tags: as many relevant ones as fit just under YouTube's 500-character limit, most specific first:
// the post's hashtags, then the clip's own metadata (song, artist, show, genre, players), then the pillar,
// then the brand's keyword bank. Brand.settings.youtubeKeywords replaces the built-in bank for a brand.
export const YOUTUBE_TAG_BUDGET = 490;
const MAX_TAG_CHARS = 30;
const BRAND_KEYWORDS = {
  stashbox: ["stashbox", "stashbox band", "stashbox music", "south florida band", "fort lauderdale band",
    "miami live music", "fort lauderdale live music", "south florida live music", "live band", "cover band",
    "tribute band", "band for hire", "private event band", "corporate event band", "wedding band",
    "live music", "original music", "indie band", "new music", "davie florida"],
  solarmeister: ["solarmeister", "solaranlage", "photovoltaik", "balkonkraftwerk", "solarstrom", "stromspeicher",
    "pv anlage", "solarmodule", "wechselrichter", "erneuerbare energie", "solar"],
  "neckermann-strom": ["neckermann strom", "strom", "ökostrom", "stromanbieter", "stromtarif", "strom sparen", "energie"]
};
const SHOW_KEYWORDS = {
  "stashbox-does-dylan": ["stashbox does dylan", "bob dylan", "bob dylan cover", "dylan covers", "bob dylan tribute",
    "dylan tribute band", "folk rock", "classic rock"],
  "stashbox-does-sublime": ["stashbox does sublime", "sublime", "sublime tribute", "sublime tribute band", "sublime covers",
    "reggae", "reggae band", "ska punk", "reggae rock"]
};
const PILLAR_KEYWORDS = {
  "live-shows": ["book a band", "live band for hire", "event entertainment"],
  radio: ["stashbox radio", "free music", "internet radio", "listen free"],
  streaming: ["spotify", "apple music", "new release", "stream now"]
};
const GENRES = ["reggae", "rock", "blues", "folk", "ska", "dub", "funk", "soul", "jazz", "pop", "hip hop", "uk garage", "psychedelic"];

// How YouTube counts the tag box: commas between tags, and quotes around a tag that contains a space.
export function youtubeTagLength(tags) {
  return tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

const words = (slug) => String(slug || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const cleanTag = (t) => String(t || "").replace(/[<>,#"]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export function youtubeTagsFor({ hashtags = [], assetTags = [], topic = null, sector = null, brandSlug = null, brandKeywords = null }) {
  const tags = assetTags.map((t) => String(t).toLowerCase());
  const valueOf = (prefix) => tags.filter((t) => t.startsWith(prefix)).map((t) => words(t.slice(prefix.length)));
  // A topic like "Get Up, Stand Up (Toots and the Maytals)" gives the song title without the artist.
  const topicSong = topic ? cleanTag(String(topic).replace(/\s*\(.*\)\s*$/, "")) : null;
  const songs = [...new Set([topicSong, ...valueOf("song:")].filter(Boolean))];
  const artists = valueOf("original-artist:");
  const shows = Object.keys(SHOW_KEYWORDS).filter((s) => tags.includes(s));
  const candidates = [
    ...hashtags.map((h) => cleanTag(String(h).replace(/^#+/, ""))),
    ...songs,
    ...songs.flatMap((s) => artists.map((a) => `${s} ${a}`)),
    ...artists,
    ...(tags.includes("cover") || tags.includes("licensed-cover") ? songs.map((s) => `${s} cover`) : []),
    ...shows.flatMap((s) => SHOW_KEYWORDS[s]),
    ...GENRES.filter((g) => tags.includes(g.replace(/ /g, "-"))),
    ...valueOf("album:"),
    ...valueOf("player:"),
    ...(PILLAR_KEYWORDS[sector] || []),
    ...(Array.isArray(brandKeywords) ? brandKeywords : BRAND_KEYWORDS[brandSlug] || [])
  ];
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    const tag = cleanTag(raw);
    if (!tag || tag.length > MAX_TAG_CHARS || seen.has(tag)) continue;
    if (youtubeTagLength([...out, tag]) > YOUTUBE_TAG_BUDGET) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

// Which week, if any, needs planning now: a requested re-plan first (every network), then the first
// week ahead that some network has no posts in, planned for just those networks. A week the Review
// page planned for Instagram + Facebook still gets YouTube, TikTok and the rest.
// plannedByDestination: { destination: [weekStart, ...] } with an entry for every active destination.
export function weekToPlan(brand, plannedByDestination) {
  const requested = brand.settings?.plannerRuntime?.replanWeek;
  if (YMD.test(String(requested || ""))) return { weekStart: requested, replace: true, destinations: null };
  let week = weekWindow(brand, null).weekStart;
  for (let i = 0; i < WEEKS_AHEAD; i++, week = addDaysToYmd(week, 7)) {
    const missing = Object.keys(plannedByDestination).filter((d) => !plannedByDestination[d].includes(week)).sort();
    if (missing.length) return { weekStart: week, replace: false, destinations: missing };
  }
  return null;
}

async function plannerTick(connectDatabase, json) {
  return withClient(connectDatabase, json, "planner-tick", async (client) => {
    const brands = (await client.query(
      `SELECT DISTINCT b."slug" FROM "Brand" b
       JOIN "SocialAccount" sa ON sa."brandId" = b."id" AND sa."status" = 'active'
       JOIN "CadenceRule" cr ON cr."socialAccountId" = sa."id" AND cr."active" = TRUE AND cr."postsPerWeek" > 0
       WHERE b."status" = 'active' AND b."settings" ? 'planner' ORDER BY b."slug"`)).rows;
    for (const { slug } of brands) {
      const brand = await loadBrand(client, slug);
      const window = weekWindow(brand, null, WEEKS_AHEAD);
      const active = (await client.query(
        `SELECT DISTINCT sa."destination" FROM "SocialAccount" sa
         JOIN "CadenceRule" cr ON cr."socialAccountId" = sa."id" AND cr."active" = TRUE AND cr."postsPerWeek" > 0
         WHERE sa."brandId" = $1 AND sa."status" = 'active'`, [brand.id])).rows.map((r) => r.destination);
      const plannedByDestination = Object.fromEntries(active.map((d) => [d, []]));
      const planned = (await client.query(
        `SELECT DISTINCT sa."destination", to_char((sp."scheduledFor" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date
                 - (EXTRACT(ISODOW FROM (sp."scheduledFor" AT TIME ZONE 'UTC' AT TIME ZONE $2)::date)::int - 1), 'YYYY-MM-DD') AS "week"
         FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
         WHERE sp."brandId" = $1 AND sp."scheduledFor" >= $3 AND sp."scheduledFor" < $4`,
        [brand.id, window.timeZone, window.from, window.to])).rows;
      for (const r of planned) plannedByDestination[r.destination]?.push(r.week);
      const next = weekToPlan(brand, plannedByDestination);
      if (!next) continue;
      // runPlanWeek opens its own connection; release ours first so the tick holds one at a time.
      await client.end();
      const raw = (status, body) => ({ status, body });
      const result = await runPlanWeek({ brandSlug: slug, weekStart: next.weekStart, mode: "apply", replacePlanned: next.replace,
        destinations: next.destinations || undefined }, connectDatabase, raw);
      if (next.replace) {
        const again = await connectDatabase();
        try {
          await again.query(`UPDATE "Brand" SET "settings" = "settings" - 'plannerRuntime', "updatedAt" = CURRENT_TIMESTAMP WHERE "slug" = $1`, [slug]);
        } finally { await again.end(); }
      }
      return json(result.status, { ok: result.status === 200, brand: slug, weekStart: next.weekStart, replaced: next.replace,
        destinations: next.destinations || "all",
        inserted: result.body.inserted ?? 0, gaps: result.body.gaps?.length ?? 0, error: result.body.error });
    }
    return json(200, { ok: true, planned: null });
  });
}

async function claimDuePosts(event, connectDatabase, json) {
  const destination = String(event.destination || "youtube");
  const limit = Math.min(5, Math.max(1, Number(event.limit) || 2));
  // A worker that only publishes some placements (e.g. a worker for only some formats) names them;
  // the others stay approved. Omitted, every placement of the destination is claimed.
  const placements = Array.isArray(event.placements) && event.placements.length ? event.placements.map(String) : null;
  return withClient(connectDatabase, json, "claim-due-posts", async (client) => {
    // A slot more than a day late is skipped, and an upload that never reported back is not retried
    // (it may have gone through), so nothing is ever posted twice. Both only touch this worker's
    // destination: other networks' approved posts wait for their own publisher.
    const missed = (await client.query(
      `UPDATE "ScheduledPost" sp SET "status" = 'missed', "updatedAt" = CURRENT_TIMESTAMP
       FROM "SocialAccount" sa
       WHERE sa."id" = sp."socialAccountId" AND sa."destination" = $1
         AND sp."status" = 'approved' AND sp."scheduledFor" < CURRENT_TIMESTAMP - INTERVAL '24 hours'`, [destination])).rowCount;
    // A worker that only uploads drafts (TikTok) can ask for one retry: a crashed upload left nothing
    // public, and a repeated draft is harmless. Everything else, and any second failure, stays failed.
    const stuck = (await client.query(
      `UPDATE "ScheduledPost" sp SET "updatedAt" = CURRENT_TIMESTAMP,
              "status" = CASE WHEN $2 AND COALESCE((sp."scoreBreakdown"->'publish'->>'retries')::int, 0) < 1 THEN 'approved' ELSE 'failed' END,
              "scoreBreakdown" = jsonb_set(COALESCE(sp."scoreBreakdown", '{}'::jsonb), '{publish}',
                CASE WHEN $2 AND COALESCE((sp."scoreBreakdown"->'publish'->>'retries')::int, 0) < 1
                  THEN '{"retries":1,"note":"Upload never reported back; queued for one retry"}'::jsonb
                  ELSE '{"error":"Upload never reported back; check the channel before retrying"}'::jsonb END, true)
       FROM "SocialAccount" sa
       WHERE sa."id" = sp."socialAccountId" AND sa."destination" = $1
         AND sp."status" = 'publishing' AND sp."updatedAt" < CURRENT_TIMESTAMP - INTERVAL '30 minutes'`, [destination, event.retryStuck === true])).rowCount;
    const posts = (await client.query(
      `WITH due AS (
         SELECT sp."id" FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
         WHERE sa."destination" = $1 AND sa."status" = 'active' AND sa."externalAccountId" IS NOT NULL
           AND sp."status" = 'approved' AND sp."scheduledFor" <= CURRENT_TIMESTAMP
           AND ($3::text[] IS NULL OR sp."placement"::text = ANY($3::text[]))
         ORDER BY sp."scheduledFor" LIMIT $2 FOR UPDATE OF sp SKIP LOCKED)
       UPDATE "ScheduledPost" sp SET "status" = 'publishing', "updatedAt" = CURRENT_TIMESTAMP
       FROM due, "SocialAccount" sa, "Asset" a
       WHERE sp."id" = due."id" AND sa."id" = sp."socialAccountId" AND a."id" = sp."assetId"
       RETURNING sp."id", sp."placement", sp."scheduledFor", sp."generatedTitle" AS "title", sp."generatedCaption" AS "caption",
                 sp."generatedHashtags" AS "hashtags", sa."externalAccountId" AS "channelId", COALESCE(a."sourcePath", a."sourceUrl") AS "dropboxPath",
                 a."filename", a."title" AS "assetTitle", sp."scoreBreakdown"->'tiktok' AS "tiktok", a."tags" AS "assetTags", sp."brandId",
                 sp."scoreBreakdown"->>'syntheticDisclosure' AS "plannedSynthetic", sp."scoreBreakdown"->>'sector' AS "sector",
                 a."topic" AS "assetTopic", sp."scoreBreakdown"->'copy'->>'primaryLink' AS "primaryLink",
                 a."kind" AS "assetKind"`, [destination, limit, placements])).rows;
    // AI-made content must be declared to the network. Judged from the clip being posted (it may have
    // been swapped since planning) with the brand's own AI tags; the planner's flag can only add to it.
    // Language: the clip's tags, else the brand's language (SolarMeister and Neckermann Strom are German).
    const brands = new Map();
    for (const brandId of new Set(posts.map((p) => p.brandId))) {
      const row = (await client.query('SELECT "slug", "timezone", "settings" FROM "Brand" WHERE "id" = $1', [brandId])).rows[0];
      brands.set(brandId, {
        settings: resolvePlannerSettings(row?.settings), language: brandLanguage(row?.slug, row?.settings),
        today: ymdInTimeZone(new Date(), row?.timezone || "America/New_York"), location: brandLocation(row?.settings),
        slug: row?.slug || null, keywords: row?.settings?.youtubeKeywords || null
      });
    }
    const out = posts.map(({ assetTags, brandId, plannedSynthetic, sector, assetTopic, ...p }) => ({
      // Pinterest picks the brand's board; one Pinterest account serves several brands.
      ...p, brand: brands.get(brandId).slug, synthetic: plannedSynthetic === "true" || isSynthetic({ tags: assetTags }, brands.get(brandId).settings),
      language: languageOf({ tags: assetTags }, brands.get(brandId).language),
      // Sponsored content must be declared; no brand has any yet, so only a "paid-promotion" clip tag says yes.
      paidPromotion: (assetTags || []).some((t) => String(t).toLowerCase() === "paid-promotion"),
      recordingDate: recordingDateOf(p.filename, brands.get(brandId).today),
      location: brands.get(brandId).location,
      ...(destination === "youtube" ? { youtubeTags: youtubeTagsFor({ hashtags: p.hashtags || [], assetTags: assetTags || [],
        topic: assetTopic, sector, brandSlug: brands.get(brandId).slug, brandKeywords: brands.get(brandId).keywords }) } : {})
    }));
    return json(200, { ok: true, missed, stuck, posts: out });
  });
}

// One-off recovery: posts a crashed worker left "Upload never reported back" go back to approved for one retry.
async function requeueFailed(event, connectDatabase, json) {
  const destination = String(event.destination || "");
  const hours = Math.min(72, Math.max(1, Number(event.hours) || 36));
  if (!destination) return json(400, { ok: false, error: "destination is required" });
  return withClient(connectDatabase, json, "requeue-failed", async (client) => {
    const rows = (await client.query(
      `UPDATE "ScheduledPost" sp SET "status" = 'approved', "updatedAt" = CURRENT_TIMESTAMP,
              "scoreBreakdown" = jsonb_set(sp."scoreBreakdown", '{publish}', '{"retries":1,"note":"Re-queued after a worker crash"}'::jsonb, true)
       FROM "SocialAccount" sa
       WHERE sa."id" = sp."socialAccountId" AND sa."destination" = $1 AND sp."status" = 'failed'
         AND sp."scoreBreakdown"->'publish'->>'error' LIKE 'Upload never reported back%'
         AND sp."updatedAt" > CURRENT_TIMESTAMP - make_interval(hours => $2)
       RETURNING sp."id", sp."scheduledFor"`, [destination, hours])).rows;
    return json(200, { ok: true, requeued: rows.length, posts: rows });
  });
}

async function finishPost(event, connectDatabase, json) {
  const id = String(event.id || "");
  if (!id) return json(400, { ok: false, error: "id is required" });
  return withClient(connectDatabase, json, "finish-post", async (client) => {
    if (!event.externalPostId) {
      const failed = await client.query(
        `UPDATE "ScheduledPost" SET "status" = 'failed', "updatedAt" = CURRENT_TIMESTAMP,
                "scoreBreakdown" = jsonb_set("scoreBreakdown", '{publish}', $2::jsonb, true)
         WHERE "id"::text = $1 AND "status" = 'publishing'`,
        [id, JSON.stringify({ error: String(event.error || "Upload failed").slice(0, 500), at: new Date().toISOString() })]);
      return json(failed.rowCount ? 200 : 404, { ok: failed.rowCount === 1, status: "failed" });
    }
    await client.query("BEGIN");
    try {
      const done = await client.query(
        `UPDATE "ScheduledPost" SET "status" = 'published', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id"::text = $1 AND "status" = 'publishing' RETURNING "id"`, [id]);
      if (!done.rowCount) { await client.query("ROLLBACK"); return json(404, { ok: false, error: "No post is publishing with that id" }); }
      await client.query(
        `INSERT INTO "PublicationLedger" ("brandId","socialAccountId","assetId","scheduledPostId","destination","placement","publishedAt",
           "method","externalPostId","externalUrl","assetFilenameSnapshot","contentGroupSnapshot","creativeFamilySnapshot","topicSnapshot")
         SELECT sp."brandId", sp."socialAccountId", sp."assetId", sp."id", sa."destination", sp."placement", CURRENT_TIMESTAMP,
                'api', $2, $3, a."filename", a."contentGroup", a."creativeFamily", a."topic"
         FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId" JOIN "Asset" a ON a."id" = sp."assetId"
         WHERE sp."id"::text = $1`, [id, String(event.externalPostId), event.externalUrl ? String(event.externalUrl) : null]);
      await client.query("COMMIT");
      return json(200, { ok: true, status: "published" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function handlePlannerOps(event, connectDatabase, json) {
  if (event.action === "planner-tick") return plannerTick(connectDatabase, json);
  if (event.action === "claim-due-posts") return claimDuePosts(event, connectDatabase, json);
  if (event.action === "requeue-failed") return requeueFailed(event, connectDatabase, json);
  if (event.action === "finish-post") return finishPost(event, connectDatabase, json);
  return json(400, { ok: false, error: "Unknown planner operation" });
}
