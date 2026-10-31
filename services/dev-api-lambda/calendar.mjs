/**
 * Calendar page backend (actions of POST /planner/review, see planner-review.mjs). One brand at a time.
 *
 *   calendar     one month grid (6 weeks from the Monday on or before the 1st, brand time zone):
 *                past = what actually published (PublicationLedger), future = approved and paused posts,
 *                plus anything the publisher is sending right now. Planned, skipped, removed, failed and
 *                missed posts stay off the calendar (they live on Review).
 *   replan-slot  "Swap": one approved or paused post gets a completely new post in the same slot
 *                (same network, format and time): a new clip picked by the planner's own pool rules, then
 *                new title, caption and hashtags from the copywriter. The status is kept.
 *
 * Remove (status "removed"), Pause ("paused"), Resume ("approved"), Edit (edit + reschedule) reuse the
 * Review actions; the publisher only claims "approved" posts, so paused and removed posts never go out.
 */
import { addDaysToYmd, ymdInTimeZone, localDateTimeToUtc, resolvePlannerSettings, poolRejection, eligibleOn,
  sectorsOf, meetsSectorRequirements, songKeyOf, isSynthetic } from "./planner-v2.mjs";
import { writeWeekCopy } from "./copywriter.mjs";
import { bedrockInvoke } from "./curator.mjs";
import { buildSongFacts, fetchRadioCatalog } from "./song-facts.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Posts on the calendar that are still to come (or being sent now).
export const CALENDAR_STATUSES = ["approved", "paused", "queued", "publishing", "processing"];
// The publisher ticks every 15 minutes; a post due sooner than this may already be claimed, so it is locked.
export const LOCK_MS = 15 * 60 * 1000;
export const CALENDAR_DAYS = 42;

/** The 6-week grid for a month: Monday on or before the 1st, 42 days. */
export function calendarGrid(month, timeZone) {
  const first = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, 1, 12)).getUTCDay(); // 0 = Sunday
  const start = addDaysToYmd(first, -((weekday + 6) % 7));
  const end = addDaysToYmd(start, CALENDAR_DAYS);
  return { month, start, end, from: localDateTimeToUtc(start, "00:00", timeZone), to: localDateTimeToUtc(end, "00:00", timeZone) };
}

const assetCard = (r) => ({ id: r.assetId, filename: r.filename, kind: r.kind, sourcePath: r.sourcePath, title: r.assetTitle, durationMs: r.durationMs });

export async function calendarMonth(client, brand, body, now = new Date()) {
  const timeZone = brand.timezone || "America/New_York";
  const month = MONTH.test(String(body.month || "")) ? body.month : ymdInTimeZone(now, timeZone).slice(0, 7);
  const grid = calendarGrid(month, timeZone);
  const lockBefore = now.getTime() + LOCK_MS;

  const scheduled = (await client.query(`
    SELECT sp."id", sp."placement", sp."scheduledFor", sp."status", sp."generatedTitle", sp."generatedCaption", sp."generatedHashtags",
           sp."scoreBreakdown", sp."assetId", sa."destination", sa."accountName",
           a."filename", a."kind", a."sourcePath", a."title" AS "assetTitle", a."durationMs"
    FROM "ScheduledPost" sp
    JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
    JOIN "Asset" a ON a."id" = sp."assetId"
    WHERE sp."brandId" = $1 AND sp."scheduledFor" >= $2 AND sp."scheduledFor" < $3 AND sp."status" = ANY($4)
    ORDER BY sp."scheduledFor", sa."destination"`, [brand.id, grid.from, grid.to, CALENDAR_STATUSES])).rows;

  const published = (await client.query(`
    SELECT pl."id", pl."scheduledPostId", pl."destination", pl."placement", pl."publishedAt", pl."externalUrl", pl."method",
           sa."accountName", sp."generatedTitle", sp."generatedCaption", sp."generatedHashtags", sp."scoreBreakdown",
           pl."assetId", COALESCE(a."filename", pl."assetFilenameSnapshot") AS "filename", a."kind", a."sourcePath", a."title" AS "assetTitle", a."durationMs"
    FROM "PublicationLedger" pl
    JOIN "SocialAccount" sa ON sa."id" = pl."socialAccountId"
    LEFT JOIN "ScheduledPost" sp ON sp."id" = pl."scheduledPostId"
    LEFT JOIN "Asset" a ON a."id" = pl."assetId"
    WHERE pl."brandId" = $1 AND pl."publishedAt" >= $2 AND pl."publishedAt" < $3
    ORDER BY pl."publishedAt", pl."destination"`, [brand.id, grid.from, grid.to])).rows;

  const posts = [
    ...scheduled.map((p) => {
      const at = new Date(p.scheduledFor);
      const passed = at.getTime() < now.getTime();
      return {
        id: p.id, postId: p.id, kind: "scheduled", status: p.status, destination: p.destination, accountName: p.accountName,
        placement: p.placement, at: at.toISOString(),
        title: p.generatedTitle, caption: p.generatedCaption, hashtags: p.generatedHashtags || [],
        asset: assetCard(p), externalUrl: null,
        carousel: Array.isArray(p.scoreBreakdown?.slideIds) && p.scoreBreakdown.slideIds.length > 0,
        custom: p.scoreBreakdown?.custom || null, tiktok: p.scoreBreakdown?.tiktok || null,
        // Paused posts whose time came are "passed over": they stay on their day, never sent late.
        passedOver: p.status === "paused" && passed,
        // Only approved/paused posts not yet due (with the 15-minute lead) can still be changed.
        editable: ["approved", "paused"].includes(p.status) && at.getTime() >= lockBefore,
        stats: null
      };
    }),
    ...published.map((p) => ({
      id: `pub:${p.id}`, postId: p.scheduledPostId || null, kind: "published", status: "published", destination: p.destination,
      accountName: p.accountName, placement: p.placement, at: new Date(p.publishedAt).toISOString(),
      title: p.generatedTitle || null, caption: p.generatedCaption || null, hashtags: p.generatedHashtags || [],
      asset: assetCard(p), externalUrl: p.externalUrl || null, method: p.method,
      carousel: Array.isArray(p.scoreBreakdown?.slideIds) && p.scoreBreakdown.slideIds.length > 0,
      custom: p.scoreBreakdown?.custom || null, tiktok: null, passedOver: false, editable: false,
      // Filled in by the stats phase (per-post insights from each network).
      stats: null
    }))
  ].sort((a, b) => a.at.localeCompare(b.at) || a.destination.localeCompare(b.destination));

  return { code: 200, body: { ok: true, brand: brand.slug, timeZone, month, start: grid.start, end: grid.end, today: ymdInTimeZone(now, timeZone), posts } };
}

/**
 * Order the replacement clips for one slot: the planner's own runners-up for this slot first, then clips of the
 * same sector, then anything else the format accepts; within a group, never-used clips first, then the longest unused.
 * Clips in their cooldown on this account, the current clip and clips this slot already had are left out.
 */
export function rankReplacements({ assets, account, settings, ymd, sector, songFacts = {}, exclude, lastUse, candidateIds = [], at }) {
  const cooldownMs = (settings.cooldowns?.assetDays ?? 30) * 86400000;
  const sectorDef = settings.sectors.find((s) => s.slug === sector);
  const ok = assets.filter((a) => !exclude.has(a.id) && !poolRejection(a, account, settings) && eligibleOn(a, ymd)
    && !(lastUse.has(a.id) && Math.abs(at.getTime() - lastUse.get(a.id)) < cooldownMs));
  const runnerUp = new Map(candidateIds.map((id, i) => [id, i]));
  const inSector = (a) => Boolean(sectorDef) && sectorsOf(a, settings).includes(sector) && meetsSectorRequirements(a, sectorDef, songFacts, settings);
  const group = (a) => (runnerUp.has(a.id) ? 0 : inSector(a) ? 1 : 2);
  return ok.sort((x, y) => group(x) - group(y)
    || (runnerUp.get(x.id) ?? 0) - (runnerUp.get(y.id) ?? 0)
    || (lastUse.get(x.id) ?? 0) - (lastUse.get(y.id) ?? 0)
    || String(x.id).localeCompare(String(y.id)));
}

const ASSET_COLUMNS = `"id","filename","kind","aspectRatioLabel","durationMs","tags","title","topic","contentGroup","creativeFamily",
  "creativeNotes","priority","eligibilityType","eligibleFrom","eligibleUntil","annualFromMmdd","annualUntilMmdd",
  "allowedDestinations","excludedDestinations","shopifyProductId","createdAt","sourcePath"`;

export async function replanSlot(client, brand, body, deps = {}) {
  if (!UUID.test(String(body.id || ""))) return { code: 400, body: { ok: false, error: "id is required" } };
  const now = deps.now || new Date();
  const timeZone = brand.timezone || "America/New_York";
  const post = (await client.query(`
    SELECT sp."id", sp."assetId", sp."placement", sp."scheduledFor", sp."status", sp."scoreBreakdown", sp."socialAccountId",
           sa."destination", sa."timezone"
    FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id" = sp."socialAccountId"
    WHERE sp."brandId" = $1 AND sp."id" = $2`, [brand.id, body.id])).rows[0];
  if (!post || !["approved", "paused"].includes(post.status)) return { code: 404, body: { ok: false, error: "Post not found, or it is no longer approved or paused" } };
  const at = new Date(post.scheduledFor);
  if (at.getTime() < now.getTime() + LOCK_MS) return { code: 409, body: { ok: false, error: "This post is about to go out and can't be swapped" } };
  const sb = post.scoreBreakdown || {};
  if (sb.custom) return { code: 409, body: { ok: false, error: "Hand-written posts can't be swapped; use Edit" } };
  if (Array.isArray(sb.slideIds) && sb.slideIds.length) return { code: 409, body: { ok: false, error: "Swap isn't available for carousel posts yet; use Edit or Remove" } };

  const settings = resolvePlannerSettings(brand.settings);
  const ymd = ymdInTimeZone(at, post.timezone || timeZone);
  const account = { socialAccountId: post.socialAccountId, destination: post.destination, placement: post.placement };
  const assets = (await client.query(
    `SELECT ${ASSET_COLUMNS} FROM "Asset"
     WHERE "brandId" = $1 AND "approvalStatus" = 'approved' AND "ingestStatus" = 'ready' AND "retiredAt" IS NULL
       AND ("sourcePath" IS NOT NULL OR "sourceUrl" IS NOT NULL)`, [brand.id])).rows;
  // When each clip was last used (or is next due) on this account, for the cooldown and the "longest unused" order.
  const uses = (await client.query(`
    SELECT "assetId", "publishedAt" AS "at" FROM "PublicationLedger" WHERE "socialAccountId" = $1 AND "publishedAt" >= $2::timestamp - INTERVAL '120 days'
    UNION ALL
    SELECT "assetId", "scheduledFor" AS "at" FROM "ScheduledPost"
    WHERE "socialAccountId" = $1 AND "id" <> $3 AND "status" IN ('planned','approved','paused','queued','publishing','processing')
      AND "scheduledFor" >= $2::timestamp - INTERVAL '120 days' AND "scheduledFor" < $2::timestamp + INTERVAL '120 days'`,
    [post.socialAccountId, at, post.id])).rows;
  const lastUse = new Map();
  for (const u of uses) {
    const t = new Date(u.at).getTime();
    // Keep the use closest to this slot: that is what the cooldown compares against.
    if (!lastUse.has(u.assetId) || Math.abs(at - t) < Math.abs(at - lastUse.get(u.assetId))) lastUse.set(u.assetId, t);
  }
  const history = Array.isArray(sb.swapHistory) ? sb.swapHistory.filter((id) => UUID.test(String(id))) : [];
  const exclude = new Set([post.assetId, ...history]);

  let songFacts = {};
  if (settings.sources?.radioSongsUrl) {
    try {
      const catalog = await (deps.fetchCatalog || fetchRadioCatalog)(settings.sources.radioSongsUrl);
      songFacts = buildSongFacts(assets.map(songKeyOf).filter(Boolean), catalog, { radioBaseUrl: settings.sources.radioBaseUrl, overrides: settings.sources.songOverrides || {} });
    } catch { songFacts = buildSongFacts(assets.map(songKeyOf).filter(Boolean), [], { radioBaseUrl: settings.sources?.radioBaseUrl, overrides: settings.sources?.songOverrides || {} }); }
  }
  const ranked = rankReplacements({ assets, account, settings, ymd, sector: sb.sector || null, songFacts, exclude, lastUse, candidateIds: sb.candidateIds || [], at });
  if (!ranked.length) return { code: 409, body: { ok: false, error: "No other approved clip fits this slot right now (format, cooldowns, earlier swaps)" } };

  const modelId = settings.copy?.enabled === false ? null : ("copyModelId" in deps ? deps.copyModelId : process.env.EPE_BEDROCK_CURATOR_MODEL_ID || null);
  const invoke = modelId ? (deps.bedrock || bedrockInvoke) : null;
  const recent = (await client.query(
    `SELECT COALESCE("generatedCaption","generatedTitle") AS "text" FROM "ScheduledPost"
     WHERE "socialAccountId" = $1 AND "id" <> $2 AND COALESCE("generatedCaption","generatedTitle") IS NOT NULL
     ORDER BY "scheduledFor" DESC LIMIT 20`, [post.socialAccountId, post.id])).rows.map((r) => r.text).reverse();

  // Try the best few clips until one gets usable copy; a clip whose caption can't be written is skipped, never posted blank.
  for (const asset of ranked.slice(0, 3)) {
    const sector = sectorsOf(asset, settings).includes(sb.sector) ? sb.sector : (sectorsOf(asset, settings)[0] || sb.sector || null);
    const slot = { slotId: post.id, socialAccountId: post.socialAccountId, destination: post.destination, placement: post.placement,
      sector, ymd, scheduledFor: at.toISOString(), assetId: asset.id, synthetic: isSynthetic(asset, settings) };
    const [written] = await writeWeekCopy({ slots: [slot], assetsById: new Map([[asset.id, asset]]), songFacts, links: settings.links || {},
      brandSlug: brand.slug, modelId, invoke, recentCaptionsByAccount: { [post.socialAccountId]: recent }, concurrency: 1,
      promotionalMaxShare: { bluesky: 0.25, ...(settings.promotionalMaxShare || {}) } });
    const copy = written?.copy;
    if (!copy || copy.status !== "ready") continue;
    const r = await client.query(`
      UPDATE "ScheduledPost" SET "assetId" = $3, "generatedTitle" = $4, "generatedCaption" = $5, "generatedHashtags" = $6,
        "selectionReason" = $7,
        "scoreBreakdown" = COALESCE("scoreBreakdown",'{}'::jsonb) || $8::jsonb, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "brandId" = $1 AND "id" = $2 AND "status" IN ('approved','paused') AND "assetId" = $9 RETURNING "id"`,
      [brand.id, post.id, asset.id, copy.title || null, copy.caption || copy.description || null, copy.hashtags || [],
        "Swapped from the calendar: a new clip and new copy for this slot",
        JSON.stringify({
          sector, songKey: songKeyOf(asset), syntheticDisclosure: slot.synthetic,
          swapHistory: [...history, post.assetId].slice(-50), swappedFrom: post.assetId, swappedAt: now.toISOString(),
          // The copy was written for the new clip, so it is not stale (Review's "caption may not match" warning stays off).
          captionEditedAfterSwap: true, replannedAt: now.toISOString(),
          copy: { source: copy.source, status: copy.status, angle: copy.angle || null, primaryLink: copy.primaryLink || null,
            description: copy.description || null, onScreenText: copy.onScreenText || null, intelligenceVersion: copy.intelligenceVersion || null,
            missing: copy.missing || [], aiRejected: copy.aiRejected || null, aiError: copy.aiError || null }
        }), post.assetId]);
    if (!r.rowCount) return { code: 409, body: { ok: false, error: "This post changed while swapping; reload and try again" } };
    return { code: 200, body: { ok: true, id: post.id, assetId: asset.id, title: copy.title || null, caption: copy.caption || copy.description || null,
      hashtags: copy.hashtags || [], copySource: copy.source } };
  }
  return { code: 409, body: { ok: false, error: "Couldn't write copy for a replacement clip; try again or use Edit" } };
}
