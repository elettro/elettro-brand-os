/**
 * Review page backend (POST /planner/review). The web app's /review page sends one
 * action per request with the shared connect key; every action is scoped to a brand.
 *
 *   list        planned/approved/skipped posts for a window (default: this week + 3)
 *   set-status  approve, skip or un-approve posts (never touches queued/published ones)
 *   approve-range  approve every planned post in a date range (e.g. a whole week)
 *   reset-week  delete a week's not-yet-sent posts and un-approve the week (back to "Plan this week")
 *   edit        rewrite a post's caption and hashtags
 *   tiktok-approve  approve one TikTok post with the settings TikTok requires the creator to pick
 *              (who can view, comments/duet/stitch, content disclosure); TikTok posts can't be
 *              approved any other way
 *   swap        replace a post's clip with another approved clip of the brand
 *   calendar    one month of the brand's calendar: published posts (PublicationLedger) plus
 *              approved, paused and sending posts (calendar.mjs)
 *   replan-slot Calendar "Swap": a new clip and freshly written copy for one approved/paused post (calendar.mjs)
 *   cadence     posts per week for one format (destination+placement) of a connected account
 *   slides      min/max images per carousel for one carousel format (within the network's limits)
 *   plan        start the week planner in the background (async self-invoke of plan-week)
 *   assets, asset, record-publication, recent-publications  test posts (library-publications.mjs)
 *
 * Planning runs async because curator + captions can outlast API Gateway's 30 s limit.
 */
import { queueCustomPost } from "./linkedin-custom.mjs";
import { calendarMonth, replanSlot } from "./calendar.mjs";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { nextWeekStart, ymdInTimeZone, addDaysToYmd, localDateTimeToUtc } from "./planner-v2.mjs";
import { searchLibrary, libraryAsset, recordPublication, recentPublications } from "./library-publications.mjs";
import { PUBLISHING_FORMATS, FORMAT_DESTINATIONS, PLANNABLE_DESTINATIONS, MAX_POSTS_PER_WEEK, MAX_POSTS_PER_DAY, formatOf, isPlannable, slideRange } from "./publishing-formats.mjs";

const lambda = new LambdaClient({});
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every network with a publishing format (publishing-formats.mjs); unconnected ones simply have no posts.
export const REVIEW_DESTINATIONS = FORMAT_DESTINATIONS;
// Statuses a reviewer may move between; queued and later belong to the publisher.
// paused (Calendar "Pause"): stays on the calendar but is passed over when its time comes; the publisher only takes approved.
// removed (Calendar "Remove"): hidden from the calendar and never sent; its slot stays taken so the planner doesn't refill it.
export const REVIEWABLE = ["planned", "approved", "skipped", "paused", "removed"];
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

// A request may narrow to some networks; by default (null) every network of the brand is covered.
const destinationsOf = (body) => {
  if (!Array.isArray(body?.destinations)) return null;
  const list = body.destinations.map((d) => String(d).toLowerCase()).filter((d) => /^[a-z][a-z-]{1,30}$/.test(d));
  return list.length ? list : null;
};

// Approving a whole week marks it approved: posts the planner adds to it later are approved too.
export const approvedWeeksOf = (settings) =>
  (Array.isArray(settings?.approvedWeeks) ? settings.approvedWeeks : []).filter((w) => YMD.test(String(w)));

// A week Review reset stays empty (the 15-minute planner tick skips it) until Plan is clicked for it.
export const heldWeeksOf = (settings) =>
  (Array.isArray(settings?.heldWeeks) ? settings.heldWeeks : []).filter((w) => YMD.test(String(w)));
const saveHeldWeeks = (client, brandId, weeks) => client.query(
  `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{heldWeeks}', $2::jsonb, true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
  [brandId, JSON.stringify(weeks.slice(-26))]);

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
    WHERE sp."brandId" = $1 AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3 AND ($4::text[] IS NULL OR sa."destination" = ANY($4))
    ORDER BY sp."scheduledFor", sa."destination"`, [brand.id, win.from, win.to, destinations])).rows;
  const candidateIds = [...new Set(posts.flatMap((p) => (p.scoreBreakdown?.candidateIds || []).slice(0, 6)))].filter((id) => UUID.test(id));
  const candidates = candidateIds.length ? (await client.query(
    'SELECT "id","filename","kind","sourcePath","title","durationMs" FROM "Asset" WHERE "id" = ANY($1::uuid[]) AND "brandId" = $2 AND "retiredAt" IS NULL',
    [candidateIds, brand.id])).rows : [];
  const byId = new Map(candidates.map((a) => [a.id, a]));
  const accounts = (await client.query(`
    SELECT sa."id" AS "socialAccountId", sa."destination", sa."accountName", sa."externalAccountId", sa."publishingMode", cr."placement", cr."postsPerWeek", cr."active"
    FROM "SocialAccount" sa LEFT JOIN "CadenceRule" cr ON cr."socialAccountId" = sa."id"
    WHERE sa."brandId" = $1 AND sa."status" = 'active' AND ($2::text[] IS NULL OR sa."destination" = ANY($2))
    ORDER BY sa."destination", cr."placement"`, [brand.id, destinations])).rows;
  return {
    ok: true, brand: brand.slug, timeZone: brand.timezone || "America/New_York", ...win,
    destinations: destinations || REVIEW_DESTINATIONS, approvedWeeks: approvedWeeksOf(brand.settings),
    hasPlannerSettings: Boolean(brand.settings?.planner?.sectors?.length), accounts,
    formats: PUBLISHING_FORMATS.map(({ rule, ...f }) => f), maxPostsPerWeek: MAX_POSTS_PER_WEEK,
    slideRanges: Object.fromEntries(PUBLISHING_FORMATS.filter((f) => f.slides).map((f) => [`${f.destination}:${f.placement}`, slideRange(brand.settings, f.destination, f.placement)])),
    posts: posts.map((p) => ({
      id: p.id, destination: p.destination, accountName: p.accountName, placement: p.placement,
      scheduledFor: new Date(p.scheduledFor).toISOString(), status: p.status,
      title: p.generatedTitle, caption: p.generatedCaption, hashtags: p.generatedHashtags || [], reason: p.selectionReason,
      sector: p.scoreBreakdown?.sector || null, copyStatus: p.scoreBreakdown?.copy?.status || null,
      tiktok: p.scoreBreakdown?.tiktok || null,
      custom: p.scoreBreakdown?.custom || null,
      failureReason: p.status === "failed" ? p.scoreBreakdown?.publish?.error || null : null,
      captionStale: Boolean(p.scoreBreakdown?.swappedFrom) && !p.scoreBreakdown?.captionEditedAfterSwap,
      asset: assetCard({ id: p.assetId, filename: p.filename, kind: p.kind, sourcePath: p.sourcePath, title: p.title, durationMs: p.durationMs }),
      candidates: (p.scoreBreakdown?.candidateIds || []).filter((id) => id !== p.assetId && byId.has(id)).slice(0, 6).map((id) => assetCard(byId.get(id)))
    }))
  };
}

async function setStatus(client, brand, body) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((id) => UUID.test(String(id)));
  const status = String(body.status || "");
  if (!ids.length || !REVIEWABLE.includes(status)) return { code: 400, body: { ok: false, error: `ids and status (${REVIEWABLE.join(", ")}) are required` } };
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
  const destinations = destinationsOf(body);
  const r = await client.query(`
    UPDATE "ScheduledPost" sp SET "status"='approved', "updatedAt"=CURRENT_TIMESTAMP
    FROM "SocialAccount" sa
    WHERE sa."id" = sp."socialAccountId" AND sp."brandId"=$1 AND sp."status"='planned'
      AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3 AND ($4::text[] IS NULL OR sa."destination" = ANY($4)) AND ${TIKTOK_READY}
    RETURNING sp."id"`, [brand.id, localDateTimeToUtc(body.from, "00:00", tz), localDateTimeToUtc(addDaysToYmd(body.to, 1), "00:00", tz), destinations]);
  // A whole week for every network: remember it, so posts the planner adds to it later arrive approved.
  const wholeWeek = !destinations && addDaysToYmd(body.from, 6) === body.to;
  if (wholeWeek) {
    const weeks = [...new Set([...approvedWeeksOf(brand.settings), body.from])].sort().slice(-26);
    await client.query(
      `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{approvedWeeks}', $2::jsonb, true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [brand.id, JSON.stringify(weeks)]);
  }
  // TikTok posts stay to review: TikTok requires the creator's choices on each post.
  const tiktokWaiting = (await client.query(`
    SELECT COUNT(*)::int AS n FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
    WHERE sp."brandId"=$1 AND sp."status"='planned' AND sa."destination"='tiktok' AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3`,
    [brand.id, localDateTimeToUtc(body.from, "00:00", tz), localDateTimeToUtc(addDaysToYmd(body.to, 1), "00:00", tz)])).rows[0]?.n || 0;
  return { code: 200, body: { ok: true, approved: r.rowCount, weekApproved: wholeWeek, tiktokWaiting } };
}

// Back to "Plan this week": deletes the week's posts that haven't gone out yet (including ones whose slot already
// passed earlier in the week, approved or not) and forgets the week's approval,
// so a fresh plan arrives unapproved. Published, queued and in-flight posts are never touched.
const RESETTABLE = ["planned", "approved", "skipped", "failed", "paused", "removed"];
async function resetWeek(client, brand, body, now = new Date()) {
  if (!YMD.test(String(body.from || "")) || !YMD.test(String(body.to || ""))) return { code: 400, body: { ok: false, error: "from and to (YYYY-MM-DD) are required" } };
  const tz = brand.timezone || "America/New_York";
  const destinations = destinationsOf(body);
  const from = localDateTimeToUtc(body.from, "00:00", tz);
  const to = localDateTimeToUtc(addDaysToYmd(body.to, 1), "00:00", tz);
  const notBefore = new Date(Math.max(from.getTime(), now.getTime()));
  const r = await client.query(`
    DELETE FROM "ScheduledPost" sp USING "SocialAccount" sa
    WHERE sa."id" = sp."socialAccountId" AND sp."brandId"=$1 AND sp."status" = ANY($2)
      AND sp."scheduledFor" < $4 AND ($5::text[] IS NULL OR sa."destination" = ANY($5))
      AND (sp."scheduledFor" >= $3 OR sp."scheduledFor" >= $6)
    RETURNING sp."id"`, [brand.id, RESETTABLE, notBefore, to, destinations, from]);
  // A whole-week reset also un-approves the week, or the next plan would arrive approved.
  const wholeWeek = !destinations && addDaysToYmd(body.from, 6) === body.to;
  if (wholeWeek) {
    const weeks = approvedWeeksOf(brand.settings).filter((w) => w !== body.from);
    await client.query(
      `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{approvedWeeks}', $2::jsonb, true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [brand.id, JSON.stringify(weeks)]);
    // Stay empty with the Plan button until asked, instead of the tick refilling the week.
    await saveHeldWeeks(client, brand.id, [...new Set([...heldWeeksOf(brand.settings), body.from])].sort());
  }
  return { code: 200, body: { ok: true, deleted: r.rowCount, weekApproved: wholeWeek ? false : undefined } };
}

// YouTube and Pinterest titles stop at 100 characters; YouTube also rejects < and >.
const TITLE_MAX = 100;

async function editCaption(client, brand, body) {
  const caption = String(body.caption ?? "").trim();
  const title = body.title === undefined ? null : String(body.title).trim();
  if (title !== null && (!title || title.length > TITLE_MAX || /[<>]/.test(title))) return { code: 400, body: { ok: false, error: `A title needs 1-${TITLE_MAX} characters and no < or >` } };
  const hashtags = (Array.isArray(body.hashtags) ? body.hashtags : []).map((h) => String(h).replace(/^#*/, "").trim()).filter(Boolean).slice(0, 30);
  if (!UUID.test(String(body.id || "")) || !caption || caption.length > 2200) return { code: 400, body: { ok: false, error: "id and a caption up to 2,200 characters are required" } };
  const r = await client.query(`
    UPDATE "ScheduledPost" SET "generatedCaption"=$3, "generatedHashtags"=$4, "generatedTitle"=COALESCE($6, "generatedTitle"),
      "scoreBreakdown" = COALESCE("scoreBreakdown",'{}'::jsonb) || jsonb_build_object('captionEditedAt', to_jsonb(CURRENT_TIMESTAMP), 'captionEditedAfterSwap', COALESCE("scoreBreakdown" ? 'swappedFrom', false)),
      "updatedAt"=CURRENT_TIMESTAMP
    WHERE "brandId"=$1 AND "id"=$2 AND "status" = ANY($5) RETURNING "id"`, [brand.id, body.id, caption, hashtags, REVIEWABLE, title]);
  return r.rowCount ? { code: 200, body: { ok: true } } : { code: 404, body: { ok: false, error: "Post not found or already queued" } };
}

// Moves one post to a new time: a later slot, or "now" so the next 15-minute run sends it. Only posts
// that have not gone out can move; a time more than an hour in the past is refused (it would count as missed).
async function reschedulePost(client, brand, body) {
  const at = new Date(String(body.scheduledFor || ""));
  if (!UUID.test(String(body.id || "")) || Number.isNaN(at.getTime())) return { code: 400, body: { ok: false, error: "id and a valid scheduledFor time are required" } };
  const now = Date.now();
  if (at.getTime() < now - 60 * 60 * 1000 || at.getTime() > now + 400 * 24 * 60 * 60 * 1000) return { code: 400, body: { ok: false, error: "Pick a time from an hour ago to a year ahead" } };
  const r = await client.query(`
    UPDATE "ScheduledPost" SET "scheduledFor"=$3,
      "scoreBreakdown" = COALESCE("scoreBreakdown",'{}'::jsonb) || jsonb_build_object('rescheduledAt', to_jsonb(CURRENT_TIMESTAMP)),
      "updatedAt"=CURRENT_TIMESTAMP
    WHERE "brandId"=$1 AND "id"=$2 AND "status" = ANY($4) RETURNING "id","scheduledFor"`, [brand.id, body.id, at.toISOString(), REVIEWABLE]);
  return r.rowCount ? { code: 200, body: { ok: true, scheduledFor: r.rows[0].scheduledFor } } : { code: 404, body: { ok: false, error: "Post not found or already queued" } };
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

// One post (id) or a week's TikTok posts at once (ids, from the week's TikTok card): the creator picks
// the settings once, sees every post's preview, and consents; the same settings go on each post.
async function tiktokApprove(client, brand, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id || "")];
  if (!ids.length || ids.length > 200 || !ids.every((id) => UUID.test(id))) return { code: 400, body: { ok: false, error: "id (or up to 200 ids) is required" } };
  let settings;
  try { settings = tiktokSettings(body); } catch (error) { return { code: 400, body: { ok: false, error: error.message } }; }
  const r = await client.query(`
    UPDATE "ScheduledPost" sp SET "status"='approved', "updatedAt"=CURRENT_TIMESTAMP,
      "scoreBreakdown" = COALESCE(sp."scoreBreakdown",'{}'::jsonb) || jsonb_build_object('tiktok', $3::jsonb)
    FROM "SocialAccount" sa
    WHERE sa."id" = sp."socialAccountId" AND sa."destination" = 'tiktok'
      AND sp."brandId"=$1 AND sp."id" = ANY($2::uuid[]) AND sp."status" = ANY($4) RETURNING sp."id"`,
    [brand.id, ids, JSON.stringify({ ...settings, approvedAt: new Date().toISOString() }), REVIEWABLE]);
  return r.rowCount ? { code: 200, body: { ok: true, status: "approved", approved: r.rowCount } }
    : { code: 404, body: { ok: false, error: "TikTok post not found or already queued" } };
}

// One rule per format of a connected account (e.g. Instagram reel and story); setting one
// format leaves the others as they are. 0 per week pauses that format. A network (one account)
// takes at most MAX_POSTS_PER_WEEK across its formats.
async function setCadence(client, brand, body) {
  const destination = String(body.destination || "").toLowerCase();
  const placement = String(body.placement || "").toLowerCase();
  const postsPerWeek = Math.floor(Number(body.postsPerWeek));
  const format = formatOf(destination, placement);
  if (!format || !(postsPerWeek >= 0 && postsPerWeek <= MAX_POSTS_PER_WEEK)) {
    return { code: 400, body: { ok: false, error: `destination, placement (a known format) and postsPerWeek (0-${MAX_POSTS_PER_WEEK}) are required` } };
  }
  if (!isPlannable(format)) return { code: 409, body: { ok: false, error: `${format.label} on ${destination}: ${format.note}` } };
  const byId = body.socialAccountId && UUID.test(String(body.socialAccountId));
  const account = (await client.query(`
    SELECT "id" FROM "SocialAccount" WHERE "brandId"=$1 AND "destination"=$2 AND "status"='active' AND "externalAccountId" IS NOT NULL
      AND ($3::uuid IS NULL OR "id"=$3::uuid)
    ORDER BY "updatedAt" DESC LIMIT 1`, [brand.id, destination, byId ? body.socialAccountId : null])).rows[0];
  if (!account) return { code: 409, body: { ok: false, error: `Connect ${destination} for ${brand.slug} first` } };
  const others = (await client.query(
    `SELECT COALESCE(SUM("postsPerWeek"),0)::int AS n FROM "CadenceRule" cr WHERE cr."socialAccountId"=$1 AND cr."placement"<>$2 AND cr."active"=TRUE`,
    [account.id, placement])).rows[0]?.n || 0;
  if (others + postsPerWeek > MAX_POSTS_PER_WEEK) {
    return { code: 400, body: { ok: false, error: `${destination} would get ${others + postsPerWeek} posts a week; the most is ${MAX_POSTS_PER_WEEK} (${MAX_POSTS_PER_DAY} a day) across its formats` } };
  }
  const rule = (await client.query('SELECT "id" FROM "CadenceRule" WHERE "socialAccountId"=$1 AND "placement"=$2 LIMIT 1', [account.id, placement])).rows[0];
  if (rule) {
    await client.query('UPDATE "CadenceRule" SET "postsPerWeek"=$2, "active"=$3, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [rule.id, postsPerWeek, postsPerWeek > 0]);
  } else {
    // Stories use the full 10:00 to 22:00 posting window; feed posts keep the afternoon window.
    const [start, end] = placement === "story" ? ["10:00", "22:00"] : ["12:00", "18:00"];
    await client.query(
      `INSERT INTO "CadenceRule" ("socialAccountId","placement","postsPerWeek","preferredDays","preferredStartTime","preferredEndTime","active","updatedAt")
       VALUES ($1,$2,$3,'{}',$4,$5,$6,CURRENT_TIMESTAMP)`, [account.id, placement, postsPerWeek, start, end, postsPerWeek > 0]);
  }
  return { code: 200, body: { ok: true, destination, placement, socialAccountId: account.id, postsPerWeek } };
}

// Min and max images per carousel for one carousel format. Stored on Brand.settings.carouselSlides, clamped by
// the planner to the network's limits; the request is refused outside them rather than silently adjusted.
async function setSlides(client, brand, body) {
  const destination = String(body.destination || "").toLowerCase();
  const placement = String(body.placement || "").toLowerCase();
  const limits = formatOf(destination, placement)?.slides;
  const min = Math.floor(Number(body.min)), max = Math.floor(Number(body.max));
  if (!limits) return { code: 400, body: { ok: false, error: "destination and placement must be a carousel format" } };
  if (!(min >= limits.min && max <= limits.max && min <= max)) {
    return { code: 400, body: { ok: false, error: `${destination} carousels take ${limits.min}-${limits.max} images; min must not exceed max` } };
  }
  const key = `${destination}:${placement}`;
  await client.query(
    `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{carouselSlides}',
       COALESCE("settings"->'carouselSlides','{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [brand.id, key, JSON.stringify({ min, max })]);
  return { code: 200, body: { ok: true, destination, placement, min, max } };
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
  // Only connected networks are planned; a planner-seed account that was never connected (X, say) stays out.
  const connected = (await client.query(
    `SELECT DISTINCT "destination" FROM "SocialAccount" WHERE "brandId"=$1 AND "status"='active' AND "externalAccountId" IS NOT NULL`,
    [brand.id])).rows.map((r) => r.destination);
  // No networks named means every network (Review plans and approves whole brand-weeks).
  const destinations = (destinationsOf(body) || PLANNABLE_DESTINATIONS).filter((d) => PLANNABLE_DESTINATIONS.includes(d) && connected.includes(d));
  if (!destinations.length) return { code: 409, body: { ok: false, error: "Connect a social account for this brand first" } };
  if (heldWeeksOf(brand.settings).includes(weekStart)) await saveHeldWeeks(client, brand.id, heldWeeksOf(brand.settings).filter((w) => w !== weekStart));
  await invoke({ action: "plan-week", brandSlug: brand.slug, weekStart, mode: "apply", replacePlanned: true, destinations });
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
    "reset-week": (c, b) => resetWeek(c, b, body, deps.now),
    edit: (c, b) => editCaption(c, b, body),
    "tiktok-approve": (c, b) => tiktokApprove(c, b, body),
    swap: (c, b) => swapAsset(c, b, body),
    reschedule: (c, b) => reschedulePost(c, b, body),
    // The Calendar page (calendar.mjs): one month, and Swap = a whole new post for one slot.
    calendar: (c, b) => calendarMonth(c, b, body, deps.now),
    "replan-slot": (c, b) => replanSlot(c, b, body, deps),
    // A hand-written LinkedIn text, link or poll post (linkedin-custom.mjs).
    "queue-custom": (c, b) => queueCustomPost(c, b, body, deps.now),
    cadence: (c, b) => setCadence(c, b, body),
    slides: (c, b) => setSlides(c, b, body),
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
