/**
 * Review page backend (POST /planner/review). The web app's /review page sends one
 * action per request with the shared connect key; every action is scoped to a brand.
 *
 *   list        planned/approved/skipped posts for a window (default: this week + 3)
 *   set-status  approve, skip or un-approve posts (never touches queued/published ones)
 *   approve-range  approve every planned post in a date range (e.g. a whole week)
 *   edit        rewrite a post's caption and hashtags
 *   tiktok-approve  approve one TikTok post with the settings TikTok requires the creator to pick
 *              (who can view, comments/duet/stitch, content disclosure); TikTok posts can't be
 *              approved any other way
 *   swap        replace a post's clip with another approved clip of the brand
 *   cadence     posts per week for one destination+placement on the connected account
 *   plan        start the week planner in the background (async self-invoke of plan-week)
 *   assets, asset, record-publication, recent-publications  test posts (library-publications.mjs)
 *
 * Planning runs async because curator + captions can outlast API Gateway's 30 s limit.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { nextWeekStart, ymdInTimeZone, addDaysToYmd, localDateTimeToUtc } from "./planner-v2.mjs";
import { searchLibrary, libraryAsset, recordPublication, recentPublications } from "./library-publications.mjs";

const lambda = new LambdaClient({});
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REVIEW_DESTINATIONS = ["instagram", "facebook", "tiktok"];
// Statuses a reviewer may move between; queued and later belong to the publisher.
const REVIEWABLE = ["planned", "approved", "skipped"];
// TikTok's Content Posting API privacy levels; the creator picks one per post, there is no default.
export const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
// A TikTok post may only be approved once its TikTok settings are stored (tiktok-approve).
const TIKTOK_READY = `(NOT EXISTS (SELECT 1 FROM "SocialAccount" t WHERE t."id" = sp."socialAccountId" AND t."destination" = 'tiktok')
  OR sp."scoreBreakdown" ? 'tiktok')`;

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const destinationsOf = (body) => {
  const list = Array.isArray(body?.destinations) ? body.destinations.map((d) => String(d).toLowerCase()) : REVIEW_DESTINATIONS;
  return list.filter((d) => REVIEW_DESTINATIONS.includes(d));
};

// The current week plus two months ahead.
export const REVIEW_MAX_WEEKS = 9;

// Monday of the brand's current week, and the UTC window covering `weeks` weeks from it.
export function reviewWindow(timeZone, weekStart, weeks, now = new Date()) {
  const start = YMD.test(String(weekStart || "")) ? weekStart : addDaysToYmd(nextWeekStart(ymdInTimeZone(now, timeZone)), -7);
  const count = Math.min(REVIEW_MAX_WEEKS, Math.max(1, Math.floor(Number(weeks) || 4)));
  return { weekStart: start, weeks: count, from: localDateTimeToUtc(start, "00:00", timeZone), to: localDateTimeToUtc(addDaysToYmd(start, 7 * count), "00:00", timeZone) };
}

async function loadBrand(client, slug) {
  return (await client.query('SELECT "id","slug","timezone","settings" FROM "Brand" WHERE "slug"=$1 AND "status"=\'active\' LIMIT 1', [slug])).rows[0] || null;
}

const assetCard = (a) => a && ({ id: a.id, filename: a.filename, kind: a.kind, sourcePath: a.sourcePath, title: a.title, durationMs: a.durationMs });

async function listPosts(client, brand, body) {
  const destinations = destinationsOf(body);
  const win = reviewWindow(brand.timezone || "America/New_York", body.weekStart, body.weeks);
  const posts = (await client.query(`
    SELECT sp."id", sp."placement", sp."scheduledFor", sp."status", sp."generatedTitle", sp."generatedCaption", sp."generatedHashtags",
           sp."selectionReason", sp."scoreBreakdown", sp."assetId", sa."destination", sa."accountName",
           a."filename", a."kind", a."sourcePath", a."title", a."durationMs"
    FROM "ScheduledPost" sp
    JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
    JOIN "Asset" a ON a."id" = sp."assetId"
    WHERE sp."brandId" = $1 AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3 AND sa."destination" = ANY($4)
    ORDER BY sp."scheduledFor", sa."destination"`, [brand.id, win.from, win.to, destinations])).rows;
  const candidateIds = [...new Set(posts.flatMap((p) => (p.scoreBreakdown?.candidateIds || []).slice(0, 6)))].filter((id) => UUID.test(id));
  const candidates = candidateIds.length ? (await client.query(
    'SELECT "id","filename","kind","sourcePath","title","durationMs" FROM "Asset" WHERE "id" = ANY($1::uuid[]) AND "brandId" = $2 AND "retiredAt" IS NULL',
    [candidateIds, brand.id])).rows : [];
  const byId = new Map(candidates.map((a) => [a.id, a]));
  const accounts = (await client.query(`
    SELECT sa."destination", sa."accountName", sa."externalAccountId", sa."publishingMode", cr."placement", cr."postsPerWeek", cr."active"
    FROM "SocialAccount" sa LEFT JOIN "CadenceRule" cr ON cr."socialAccountId" = sa."id"
    WHERE sa."brandId" = $1 AND sa."status" = 'active' AND sa."destination" = ANY($2)
    ORDER BY sa."destination", cr."placement"`, [brand.id, destinations])).rows;
  return {
    ok: true, brand: brand.slug, timeZone: brand.timezone || "America/New_York", ...win, destinations,
    hasPlannerSettings: Boolean(brand.settings?.planner?.sectors?.length), accounts,
    posts: posts.map((p) => ({
      id: p.id, destination: p.destination, accountName: p.accountName, placement: p.placement,
      scheduledFor: new Date(p.scheduledFor).toISOString(), status: p.status,
      title: p.generatedTitle, caption: p.generatedCaption, hashtags: p.generatedHashtags || [], reason: p.selectionReason,
      sector: p.scoreBreakdown?.sector || null, copyStatus: p.scoreBreakdown?.copy?.status || null,
      tiktok: p.scoreBreakdown?.tiktok || null,
      captionStale: Boolean(p.scoreBreakdown?.swappedFrom) && !p.scoreBreakdown?.captionEditedAfterSwap,
      asset: assetCard({ id: p.assetId, filename: p.filename, kind: p.kind, sourcePath: p.sourcePath, title: p.title, durationMs: p.durationMs }),
      candidates: (p.scoreBreakdown?.candidateIds || []).filter((id) => id !== p.assetId && byId.has(id)).slice(0, 6).map((id) => assetCard(byId.get(id)))
    }))
  };
}

async function setStatus(client, brand, body) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => UUID.test(String(id)));
  const status = String(body.status || "");
  if (!ids.length || !REVIEWABLE.includes(status)) return { code: 400, body: { ok: false, error: "ids and status (planned, approved or skipped) are required" } };
  const r = await client.query(
    `UPDATE "ScheduledPost" sp SET "status"=$3, "updatedAt"=CURRENT_TIMESTAMP
     WHERE sp."brandId"=$1 AND sp."id" = ANY($2::uuid[]) AND sp."status" = ANY($4)
       AND ($3 <> 'approved' OR ${TIKTOK_READY}) RETURNING sp."id"`, [brand.id, ids, status, REVIEWABLE]);
  if (status === "approved" && r.rowCount < ids.length) {
    return { code: 409, body: { ok: false, error: "TikTok posts are approved from their TikTok card (who can view, comments, disclosure)", updated: r.rowCount } };
  }
  return { code: 200, body: { ok: true, status, updated: r.rowCount } };
}

async function approveRange(client, brand, body) {
  if (!YMD.test(String(body.from || "")) || !YMD.test(String(body.to || ""))) return { code: 400, body: { ok: false, error: "from and to (YYYY-MM-DD) are required" } };
  const tz = brand.timezone || "America/New_York";
  const r = await client.query(`
    UPDATE "ScheduledPost" sp SET "status"='approved', "updatedAt"=CURRENT_TIMESTAMP
    FROM "SocialAccount" sa
    WHERE sa."id" = sp."socialAccountId" AND sp."brandId"=$1 AND sp."status"='planned'
      AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3 AND sa."destination" = ANY($4) AND ${TIKTOK_READY}
    RETURNING sp."id"`, [brand.id, localDateTimeToUtc(body.from, "00:00", tz), localDateTimeToUtc(addDaysToYmd(body.to, 1), "00:00", tz), destinationsOf(body)]);
  return { code: 200, body: { ok: true, approved: r.rowCount } };
}

async function editCaption(client, brand, body) {
  const caption = String(body.caption ?? "").trim();
  const hashtags = (Array.isArray(body.hashtags) ? body.hashtags : []).map((h) => String(h).replace(/^#*/, "").trim()).filter(Boolean).slice(0, 30);
  if (!UUID.test(String(body.id || "")) || !caption || caption.length > 2200) return { code: 400, body: { ok: false, error: "id and a caption up to 2,200 characters are required" } };
  const r = await client.query(`
    UPDATE "ScheduledPost" SET "generatedCaption"=$3, "generatedHashtags"=$4,
      "scoreBreakdown" = COALESCE("scoreBreakdown",'{}'::jsonb) || jsonb_build_object('captionEditedAt', to_jsonb(CURRENT_TIMESTAMP), 'captionEditedAfterSwap', COALESCE("scoreBreakdown" ? 'swappedFrom', false)),
      "updatedAt"=CURRENT_TIMESTAMP
    WHERE "brandId"=$1 AND "id"=$2 AND "status" = ANY($5) RETURNING "id"`, [brand.id, body.id, caption, hashtags, REVIEWABLE]);
  return r.rowCount ? { code: 200, body: { ok: true } } : { code: 404, body: { ok: false, error: "Post not found or already queued" } };
}

async function swapAsset(client, brand, body) {
  if (!UUID.test(String(body.id || "")) || !UUID.test(String(body.assetId || ""))) return { code: 400, body: { ok: false, error: "id and assetId are required" } };
  const asset = (await client.query(
    `SELECT "id" FROM "Asset" WHERE "id"=$1 AND "brandId"=$2 AND "approvalStatus"='approved' AND "ingestStatus"='ready' AND "retiredAt" IS NULL`,
    [body.assetId, brand.id])).rows[0];
  if (!asset) return { code: 404, body: { ok: false, error: "That clip is not an approved, ready asset of this brand" } };
  const r = await client.query(`
    UPDATE "ScheduledPost" SET
      "scoreBreakdown" = COALESCE("scoreBreakdown",'{}'::jsonb) || jsonb_build_object('swappedFrom', "assetId"::text, 'swappedAt', to_jsonb(CURRENT_TIMESTAMP), 'captionEditedAfterSwap', false),
      "assetId"=$3, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "brandId"=$1 AND "id"=$2 AND "status" = ANY($4) AND "assetId" <> $3 RETURNING "id"`, [brand.id, body.id, body.assetId, REVIEWABLE]);
  return r.rowCount ? { code: 200, body: { ok: true } } : { code: 404, body: { ok: false, error: "Post not found, already queued, or already using that clip" } };
}

// TikTok's posting rules: the creator picks who can view (no default), interactions and the
// commercial content disclosure; branded content (a paid partnership) can't be private.
export function tiktokSettings(body) {
  const privacyLevel = String(body?.privacyLevel || "");
  if (!TIKTOK_PRIVACY.includes(privacyLevel)) throw new Error("Choose who can view this TikTok post");
  const settings = {
    privacyLevel,
    allowComment: body.allowComment === true, allowDuet: body.allowDuet === true, allowStitch: body.allowStitch === true,
    yourBrand: body.yourBrand === true, brandedContent: body.brandedContent === true
  };
  if (body.disclose === true && !settings.yourBrand && !settings.brandedContent) {
    throw new Error("Content disclosure is on: pick Your brand, Branded content, or both");
  }
  if (settings.brandedContent && privacyLevel === "SELF_ONLY") throw new Error("Branded content can't be private");
  return settings;
}

async function tiktokApprove(client, brand, body) {
  if (!UUID.test(String(body.id || ""))) return { code: 400, body: { ok: false, error: "id is required" } };
  let settings;
  try { settings = tiktokSettings(body); } catch (error) { return { code: 400, body: { ok: false, error: error.message } }; }
  const r = await client.query(`
    UPDATE "ScheduledPost" sp SET "status"='approved', "updatedAt"=CURRENT_TIMESTAMP,
      "scoreBreakdown" = COALESCE(sp."scoreBreakdown",'{}'::jsonb) || jsonb_build_object('tiktok', $3::jsonb)
    FROM "SocialAccount" sa
    WHERE sa."id" = sp."socialAccountId" AND sa."destination" = 'tiktok'
      AND sp."brandId"=$1 AND sp."id"=$2 AND sp."status" = ANY($4) RETURNING sp."id"`,
    [brand.id, body.id, JSON.stringify({ ...settings, approvedAt: new Date().toISOString() }), REVIEWABLE]);
  return r.rowCount ? { code: 200, body: { ok: true, status: "approved" } } : { code: 404, body: { ok: false, error: "TikTok post not found or already queued" } };
}

// One rule per connected account: the requested placement gets postsPerWeek, other placements pause.
async function setCadence(client, brand, body) {
  const destination = String(body.destination || "").toLowerCase();
  const placement = String(body.placement || "").toLowerCase();
  const postsPerWeek = Math.floor(Number(body.postsPerWeek));
  if (!REVIEW_DESTINATIONS.includes(destination) || !/^[a-z]{2,20}$/.test(placement) || !(postsPerWeek >= 0 && postsPerWeek <= 70)) {
    return { code: 400, body: { ok: false, error: "destination, placement and postsPerWeek (0-70) are required" } };
  }
  const account = (await client.query(`
    SELECT "id" FROM "SocialAccount" WHERE "brandId"=$1 AND "destination"=$2 AND "status"='active' AND "externalAccountId" IS NOT NULL
    ORDER BY "updatedAt" DESC LIMIT 1`, [brand.id, destination])).rows[0];
  if (!account) return { code: 409, body: { ok: false, error: `Connect ${destination} for ${brand.slug} first` } };
  await client.query("BEGIN");
  try {
    await client.query('UPDATE "CadenceRule" SET "active"=FALSE, "updatedAt"=CURRENT_TIMESTAMP WHERE "socialAccountId"=$1 AND "placement"<>$2', [account.id, placement]);
    const rule = (await client.query('SELECT "id" FROM "CadenceRule" WHERE "socialAccountId"=$1 AND "placement"=$2 LIMIT 1', [account.id, placement])).rows[0];
    if (rule) {
      await client.query('UPDATE "CadenceRule" SET "postsPerWeek"=$2, "active"=TRUE, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [rule.id, postsPerWeek]);
    } else {
      await client.query(
        `INSERT INTO "CadenceRule" ("socialAccountId","placement","postsPerWeek","preferredDays","preferredStartTime","preferredEndTime","active","updatedAt")
         VALUES ($1,$2,$3,'{}','12:00','18:00',TRUE,CURRENT_TIMESTAMP)`, [account.id, placement, postsPerWeek]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { code: 200, body: { ok: true, destination, placement, postsPerWeek } };
}

// Brands without Brand.settings.planner get the repo seed (intelligence/brands/<slug>/planner.json).
async function ensurePlannerSettings(client, brand, readSeed) {
  if (brand.settings?.planner?.sectors?.length) return true;
  let seed;
  try { seed = JSON.parse(readSeed(brand.slug))?.settings; } catch { return false; }
  if (!seed?.sectors?.length) return false;
  await client.query(
    `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{planner}', $2::jsonb, true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [brand.id, JSON.stringify(seed)]);
  return true;
}

const readRepoSeed = (slug) => readFileSync(new URL(`./intelligence/brands/${slug}/planner.json`, import.meta.url), "utf8");

async function startPlanning(client, brand, body, { invoke, readSeed, now = new Date() }) {
  if (body.weekStart && !YMD.test(String(body.weekStart))) return { code: 400, body: { ok: false, error: "weekStart must be YYYY-MM-DD" } };
  if (!(await ensurePlannerSettings(client, brand, readSeed))) return { code: 409, body: { ok: false, error: "This brand has no planner settings yet" } };
  const today = ymdInTimeZone(now, brand.timezone || "America/New_York");
  const weekStart = body.weekStart || nextWeekStart(today);
  // A week under way plans only its remaining days (plan-week skips past slots); a finished one can't be planned.
  if (addDaysToYmd(weekStart, 6) < today) return { code: 400, body: { ok: false, error: "That week is already over" } };
  // IAM-style event (no requestContext) so index.mjs routes it to the existing plan-week action.
  await invoke({ action: "plan-week", brandSlug: brand.slug, weekStart, mode: "apply", replacePlanned: true, destinations: destinationsOf(body) });
  return { code: 202, body: { ok: true, planning: true, weekStart } };
}

const selfInvoke = (payload) => lambda.send(new InvokeCommand({
  FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload))
}));

export async function handlePlannerReview(event, body, connectDatabase, json, deps = {}) {
  if (!keyMatches((event?.headers || {})["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const slug = String(body?.brand || "");
  const action = String(body?.action || "");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return json(400, { ok: false, error: "brand is required" });
  const handlers = {
    list: async (c, b) => ({ code: 200, body: await listPosts(c, b, body) }),
    "set-status": (c, b) => setStatus(c, b, body),
    "approve-range": (c, b) => approveRange(c, b, body),
    edit: (c, b) => editCaption(c, b, body),
    "tiktok-approve": (c, b) => tiktokApprove(c, b, body),
    swap: (c, b) => swapAsset(c, b, body),
    cadence: (c, b) => setCadence(c, b, body),
    plan: (c, b) => startPlanning(c, b, body, { invoke: deps.invoke || selfInvoke, readSeed: deps.readSeed || readRepoSeed, now: deps.now }),
    // Connections page test posts: library picker + publication log (library-publications.mjs).
    assets: (c, b) => searchLibrary(c, b, body),
    asset: (c, b) => libraryAsset(c, b, body),
    "record-publication": (c, b) => recordPublication(c, b, body),
    "recent-publications": (c, b) => recentPublications(c, b)
  };
  const handler = handlers[action];
  if (!handler) return json(400, { ok: false, error: "Unknown review action" });
  let client;
  try {
    client = await connectDatabase();
    const brand = await loadBrand(client, slug);
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const result = await handler(client, brand);
    return json(result.code, result.body);
  } catch (error) {
    console.error("[planner-review] failed", action, error?.name, error?.message);
    return json(500, { ok: false, error: "Review action failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
