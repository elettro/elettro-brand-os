// YouTube post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only: nothing here changes anything on YouTube.
//
// For every published video that reached an age bucket (1h, 24h, 7d, 30d) without a snapshot, the numbers come from two places:
//   - the YouTube Data API `videos.list?part=statistics` (scope youtube.readonly): views, likes, comments, available at once;
//   - the YouTube Analytics API `reports` (scope yt-analytics.readonly): watch time, average view duration, shares and subscribers
//     gained. Analytics lags by roughly two days, so the 1h and 24h snapshots usually hold the Data API numbers only.
// Both raw answers are kept so the numbers can be recomputed later.

const DATA_API = "https://www.googleapis.com/youtube/v3/videos";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const ANALYTICS_METRICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "subscribersGained"];

const day = (value) => new Date(value).toISOString().slice(0, 10);

export function statisticsUrl(videoId) {
  return `${DATA_API}?${new URLSearchParams({ part: "statistics", id: videoId })}`;
}

/** Analytics report for one video from its publish day to `now`; with no videoId, the whole channel for the last 28 days. */
export function analyticsUrl({ videoId, publishedAt, now = Date.now() }) {
  const params = new URLSearchParams({
    ids: "channel==MINE",
    metrics: ANALYTICS_METRICS.join(","),
    startDate: day(videoId ? publishedAt : now - 28 * 24 * 60 * 60 * 1000),
    endDate: day(now)
  });
  if (videoId) params.set("filters", `video==${videoId}`);
  return `${ANALYTICS_API}?${params}`;
}

const num = (value) => (value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** One metrics object: public counters from the Data API `statistics` answer; watch time, average view, shares and subscribers from the Analytics report. */
export function snapshotFrom(statistics, report) {
  const stats = statistics?.items?.[0]?.statistics || {};
  const headers = (report?.columnHeaders || []).map((h) => h.name);
  const row = Array.isArray(report?.rows) ? report.rows[0] : null;
  const at = (name) => (row && headers.includes(name) ? num(row[headers.indexOf(name)]) : null);
  const minutes = at("estimatedMinutesWatched");
  const metrics = {
    // Views, likes and comments are the PUBLIC counters (what the video page shows), so a number can be checked on the page. Analytics counts
    // differently (a comment since deleted or held for review still counts; on 2026-11-08 it said 3 where the page said 0), so it only fills
    // them in when the Data API gave nothing.
    views: num(stats.viewCount) ?? at("views"),
    likes: num(stats.likeCount) ?? at("likes"),
    comments: num(stats.commentCount) ?? at("comments"),
    shares: at("shares"),
    watchTimeSeconds: minutes === null ? null : Math.round(minutes * 60),
    avgViewDurationSeconds: at("averageViewDuration"),
    followsGained: at("subscribersGained")
  };
  return { source: row ? "analytics" : "statistics", metrics };
}

async function getJson(url, accessToken) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body, reason: body?.error?.message || body?.error?.status || null };
}

/** Does this channel's token reach the Analytics API? Reports the status and the reason, never the data. */
export async function checkAnalyticsAccess(accessToken) {
  const answer = await getJson(analyticsUrl({}), accessToken);
  return { ok: answer.ok, status: answer.status, reason: answer.ok ? null : String(answer.reason || "unknown").slice(0, 200) };
}

/**
 * One due video: fetch both sources and return the snapshots for each bucket that is due. A video the Data API no longer returns
 * (deleted or private) yields nothing, so it is retried on the next tick rather than saved as zeros.
 */
export async function collectForVideo(item, accessToken, now = Date.now()) {
  const stats = await getJson(statisticsUrl(item.videoId), accessToken);
  if (!stats.ok) throw new Error(`videos.list failed (HTTP ${stats.status}: ${stats.reason || "no reason"})`);
  if (!stats.body.items?.length) return [];
  // Analytics trouble (scope missing, report not ready) must not lose the Data API numbers.
  const analytics = await getJson(analyticsUrl({ videoId: item.videoId, publishedAt: item.publishedAt, now }), accessToken).catch((error) => ({ ok: false, status: 0, reason: error.message, body: {} }));
  const { source, metrics } = snapshotFrom(stats.body, analytics.ok ? analytics.body : null);
  const raw = { statistics: stats.body.items[0].statistics || null, analytics: analytics.ok ? { columnHeaders: analytics.body.columnHeaders, rows: analytics.body.rows } : { error: analytics.status, reason: String(analytics.reason || "").slice(0, 200) } };
  return item.buckets.map((ageBucket) => ({ ledgerId: item.ledgerId, ageBucket, source, metrics, raw }));
}
