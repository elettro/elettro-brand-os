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

// Instagram media insights. Reels also have watch time (milliseconds).
export const INSTAGRAM_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"];
export const INSTAGRAM_REEL_METRICS = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
// Facebook post and video insights; the object itself also carries reaction, comment and share counts.
export const FACEBOOK_METRICS = ["post_media_view", "post_total_media_view_unique"];
export const FACEBOOK_VIDEO_METRICS = ["total_video_views", "total_video_avg_time_watched", "total_video_view_total_time"];

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
    raw[metric] = answers[i].ok ? insightValue(answers[i].body) : { error: answers[i].error };
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
export async function facebookSnapshot({ postId, placement }, accessToken, call) {
  const isVideo = placement === "reel" || placement === "video";
  const { got, raw } = await insights(call, `${postId}/${isVideo ? "video_insights" : "insights"}`, isVideo ? FACEBOOK_VIDEO_METRICS : FACEBOOK_METRICS, accessToken);
  // Reactions, comments and shares sit on the object itself. A video id has no `shares` field of its own.
  const wanted = isVideo ? "likes.summary(true).limit(0),comments.summary(true).limit(0)" : "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares";
  const fields = await ask(call, postId, { fields: wanted }, accessToken);
  const body = fields.ok ? fields.body : {};
  const counts = { reactions: body.reactions?.summary?.total_count ?? body.likes?.summary?.total_count ?? null, comments: body.comments?.summary?.total_count ?? null, shares: body.shares?.count ?? null };
  const metrics = {
    views: got.post_media_view ?? got.total_video_views ?? null,
    reach: got.post_total_media_view_unique ?? null,
    likes: num(counts.reactions),
    comments: num(counts.comments),
    shares: num(counts.shares),
    saves: null,
    watchTimeSeconds: seconds(got.total_video_view_total_time),
    avgViewDurationSeconds: got.total_video_avg_time_watched === undefined || got.total_video_avg_time_watched === null ? null : got.total_video_avg_time_watched / 1000,
    followsGained: null
  };
  return { metrics, raw: { insights: raw, fields: fields.ok ? counts : { error: fields.error } } };
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
