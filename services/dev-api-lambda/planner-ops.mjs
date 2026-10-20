// The Planner page and the publishing loop around Planner V2.
//   POST /planner (web, connect key): view | set-cadence | approve-week | request-replan
//   IAM-only (the YouTube upload worker calls these every 15 minutes):
//     planner-tick     plan the next unplanned week, or a week the page asked to re-plan (one per call)
//     claim-due-posts  hand out approved posts whose time has come, marked 'publishing'
//     finish-post      record the outcome: 'published' + a PublicationLedger row, or 'failed'
import { withClient, loadBrand, weekWindow, runPlanWeek, approvePlannerWeek } from "./planner-v2-db.mjs";
import { addDaysToYmd } from "./planner-v2.mjs";
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
  if (body.action === "set-cadence") return setCadence(body, connectDatabase, json);
  if (body.action === "request-replan") return requestReplan(body, connectDatabase, json);
  if (body.action === "approve-week") {
    if (!YMD.test(String(body.weekStart || ""))) return json(400, { ok: false, error: "weekStart (YYYY-MM-DD) is required" });
    return approvePlannerWeek({ brandSlug: body.brandSlug, weekStart: body.weekStart }, connectDatabase, json);
  }
  return json(400, { ok: false, error: "Unknown planner action" });
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
  return withClient(connectDatabase, json, "claim-due-posts", async (client) => {
    // A slot more than a day late is skipped, and an upload that never reported back is not retried
    // (it may have gone through), so nothing is ever posted twice. Both only touch this worker's
    // destination: other networks' approved posts wait for their own publisher.
    const missed = (await client.query(
      `UPDATE "ScheduledPost" sp SET "status" = 'missed', "updatedAt" = CURRENT_TIMESTAMP
       FROM "SocialAccount" sa
       WHERE sa."id" = sp."socialAccountId" AND sa."destination" = $1
         AND sp."status" = 'approved' AND sp."scheduledFor" < CURRENT_TIMESTAMP - INTERVAL '24 hours'`, [destination])).rowCount;
    const stuck = (await client.query(
      `UPDATE "ScheduledPost" sp SET "status" = 'failed', "updatedAt" = CURRENT_TIMESTAMP,
              "scoreBreakdown" = jsonb_set(sp."scoreBreakdown", '{publish}', '{"error":"Upload never reported back; check the channel before retrying"}'::jsonb, true)
       FROM "SocialAccount" sa
       WHERE sa."id" = sp."socialAccountId" AND sa."destination" = $1
         AND sp."status" = 'publishing' AND sp."updatedAt" < CURRENT_TIMESTAMP - INTERVAL '30 minutes'`, [destination])).rowCount;
    const posts = (await client.query(
      `WITH due AS (
         SELECT sp."id" FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
         WHERE sa."destination" = $1 AND sa."status" = 'active' AND sa."externalAccountId" IS NOT NULL
           AND sp."status" = 'approved' AND sp."scheduledFor" <= CURRENT_TIMESTAMP
         ORDER BY sp."scheduledFor" LIMIT $2 FOR UPDATE OF sp SKIP LOCKED)
       UPDATE "ScheduledPost" sp SET "status" = 'publishing', "updatedAt" = CURRENT_TIMESTAMP
       FROM due, "SocialAccount" sa, "Asset" a
       WHERE sp."id" = due."id" AND sa."id" = sp."socialAccountId" AND a."id" = sp."assetId"
       RETURNING sp."id", sp."placement", sp."scheduledFor", sp."generatedTitle" AS "title", sp."generatedCaption" AS "caption",
                 sp."generatedHashtags" AS "hashtags", sa."externalAccountId" AS "channelId", a."sourcePath" AS "dropboxPath",
                 a."filename", a."title" AS "assetTitle"`, [destination, limit])).rows;
    return json(200, { ok: true, missed, stuck, posts });
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
  if (event.action === "finish-post") return finishPost(event, connectDatabase, json);
  return json(400, { ok: false, error: "Unknown planner operation" });
}
