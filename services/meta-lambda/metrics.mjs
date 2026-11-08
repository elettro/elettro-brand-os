// Instagram and Facebook post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only: nothing here changes anything on Meta.
//
// Every number is its own small request, so a metric Meta does not offer for one kind of post (they differ between Reels, photos and
// videos, and Meta renames them often) costs only that number, never the whole snapshot. What each request answered, or why it
// failed, is kept in `raw` so the mapping can be fixed afterwards without losing data.

const seconds = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 1000));
const num = (value) => (value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** The number inside an insights answer: { data: [{ name, values: [{ value }] }] } or { data: [{ total_value: { value } }] }. */
export function insightValue(body) {
  const entry = body?.data?.[0];
  if (!entry) return null;
  const value = entry.total_value?.value ?? entry.values?.[0]?.value;
  return typeof value === "object" && value !== null ? null : num(value);
}

/** A breakdown answer (reactions by type) added up; null when there is none. */
export function insightSum(body) {
  const value = body?.data?.[0]?.values?.[0]?.value ?? body?.data?.[0]?.total_value?.value;
  if (value === null || typeof value !== "object") return num(value);
  const parts = Object.values(value).map(num).filter((n) => n !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

// Instagram media insights. Reels also have watch time (milliseconds).
export const INSTAGRAM_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"];
export const INSTAGRAM_REEL_METRICS = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
// Facebook post and video insights; the object itself also carries reaction, comment and share counts.
export const FACEBOOK_METRICS = ["post_media_view", "post_total_media_view_unique", "post_reactions_by_type_total"];
// Reels answer to the Reels names; "total_video_*" came back empty for Reels on 2026-11-07, so several spellings are asked and the first to answer wins.
export const FACEBOOK_VIDEO_METRICS = ["fb_reels_total_plays", "blue_reels_play_count", "post_video_avg_time_watched", "post_video_view_time", "post_impressions_unique", "total_video_views", "total_video_avg_time_watched", "total_video_view_total_time"];

async function ask(call, path, params, accessToken) {
  try {
    return { ok: true, body: await call("GET", path, params, accessToken, `${path}`) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
}

async function insights(call, path, names, accessToken) {
  const answers = await Promise.all(names.map((metric) => ask(call, path, { metric }, accessToken)));
  const got = {};
  const raw = {};
  names.forEach((metric, i) => {
    raw[metric] = answers[i].ok ? insightSum(answers[i].body) : { error: answers[i].error };
    if (answers[i].ok) got[metric] = raw[metric];
  });
  return { got, raw };
}

/** Instagram: one snapshot for one media id. `placement` "reel" adds the watch-time numbers. */
export async function instagramSnapshot({ postId, placement }, accessToken, call) {
  const names = [...INSTAGRAM_METRICS, ...(placement === "reel" ? INSTAGRAM_REEL_METRICS : [])];
  const { got, raw } = await insights(call, `${postId}/insights`, names, accessToken);
  // Like and comment counts are also plain fields on the media; they answer even when an insights request does not.
  const fields = await ask(call, postId, { fields: "like_count,comments_count" }, accessToken);
  const body = fields.ok ? fields.body : {};
  const metrics = {
    views: got.views ?? null,
    reach: got.reach ?? null,
    likes: got.likes ?? num(body.like_count),
    comments: got.comments ?? num(body.comments_count),
    shares: got.shares ?? null,
    saves: got.saved ?? null,
    watchTimeSeconds: seconds(got.ig_reels_video_view_total_time),
    avgViewDurationSeconds: got.ig_reels_avg_watch_time === undefined || got.ig_reels_avg_watch_time === null ? null : got.ig_reels_avg_watch_time / 1000,
    followsGained: null
  };
  return { metrics, raw: { insights: raw, fields: fields.ok ? { like_count: body.like_count ?? null, comments_count: body.comments_count ?? null } : { error: fields.error } } };
}

/** Facebook: one snapshot for a post, photo, video or Reel id. */
export async function facebookSnapshot(item, accessToken, call) {
  const { placement } = item;
  let isVideo = placement === "reel" || placement === "video";
  let postId = item.postId;
  // An id with no underscore is either a photo (its post id, pageId_postId, is on `page_story_id`) or a wide video posted as a "post"
  // (only a photo has that field), and a video is read through video insights like a Reel.
  if (!isVideo && !String(postId).includes("_")) {
    const story = await ask(call, postId, { fields: "page_story_id" }, accessToken);
    if (story.ok && story.body.page_story_id) postId = story.body.page_story_id;
    else if (!story.ok) isVideo = true;
  }
  const { got, raw } = await insights(call, `${postId}/${isVideo ? "video_insights" : "insights"}`, isVideo ? FACEBOOK_VIDEO_METRICS : FACEBOOK_METRICS, accessToken);
  // Reactions, comments and shares sit on the object itself. A video id has no `shares` field of its own.
  const wanted = isVideo ? "likes.summary(true).limit(0),comments.summary(true).limit(0)" : "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares";
  const fields = await ask(call, postId, { fields: wanted }, accessToken);
  const body = fields.ok ? fields.body : {};
  const counts = { reactions: body.reactions?.summary?.total_count ?? body.likes?.summary?.total_count ?? null, comments: body.comments?.summary?.total_count ?? null, shares: body.shares?.count ?? null };
  const metrics = {
    views: got.post_media_view ?? got.fb_reels_total_plays ?? got.blue_reels_play_count ?? got.total_video_views ?? null,
    reach: got.post_total_media_view_unique ?? got.post_impressions_unique ?? null,
    likes: num(counts.reactions) ?? got.post_reactions_by_type_total ?? null,
    comments: num(counts.comments),
    shares: num(counts.shares),
    saves: null,
    watchTimeSeconds: seconds(got.post_video_view_time ?? got.total_video_view_total_time),
    avgViewDurationSeconds: (() => { const ms = got.post_video_avg_time_watched ?? got.total_video_avg_time_watched; return ms === undefined || ms === null ? null : ms / 1000; })(),
    followsGained: null
  };
  return { metrics, raw: { postId, insights: raw, fields: fields.ok ? counts : { error: fields.error } } };
}

/**
 * Snapshots for one due post, one per bucket. A post none of whose requests answered yields an error, so it is retried on the next
 * tick instead of being saved as zeros (a post gone from Meta, or a token without insights access).
 */
export async function collectForPost(destination, item, accessToken, call) {
  const snapshot = destination === "instagram" ? await instagramSnapshot(item, accessToken, call) : await facebookSnapshot(item, accessToken, call);
  if (!Object.values(snapshot.metrics).some((v) => v !== null)) {
    throw new Error(`no ${destination} number came back for ${item.postId}: ${JSON.stringify(snapshot.raw).slice(0, 300)}`);
  }
  const source = `${destination}-insights`;
  return item.buckets.map((ageBucket) => ({ ledgerId: item.ledgerId, ageBucket, source, metrics: snapshot.metrics, raw: snapshot.raw }));
}

// Verification (2026-11-08): the stored snapshot next to the live number from the network, for a post that is at least a day old. The fields
// are the normalized ones; only those either side has are listed. Read only.
const COMPARE_FIELDS = ["views", "reach", "likes", "comments", "shares", "saves", "linkClicks"];
export function compareSnapshot(row, live) {
  const stored = {};
  const now = {};
  const differs = [];
  for (const field of COMPARE_FIELDS) {
    const a = row[field] === null || row[field] === undefined ? null : Number(row[field]);
    const b = live?.[field] === null || live?.[field] === undefined ? null : Number(live[field]);
    if (a === null && b === null) continue;
    stored[field] = a;
    now[field] = b;
    if (a !== b) differs.push(field);
  }
  const hours = Math.round((Date.parse(row.capturedAt) - Date.parse(row.publishedAt)) / 360000) / 10;
  return { url: row.externalUrl || row.externalPostId, brand: row.brand, placement: row.placement, publishedAt: row.publishedAt, bucket: row.ageBucket, takenAfterHours: Number.isFinite(hours) ? hours : null, stored, live: now, differs };
}

/** The newest snapshot of each post that is at least a day old, newest posts first, up to `limit`. */
export function postsToVerify(rows, limit = 6, now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (seen.has(row.ledgerId) || row.placement === "story") continue;
    if (now - Date.parse(row.publishedAt) < 24 * 3600000) continue;
    seen.add(row.ledgerId);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
