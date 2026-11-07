// Pinterest pin metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only. Scope: pins:read.
//
// `GET /v5/pins/{id}/analytics` takes a date range and a list of metrics, and refuses the whole request when one metric does not suit
// the pin (video metrics on an image pin, for one). So each metric is its own request: an unsuitable one costs only itself and its
// error is kept in `raw`. Pinterest answers { all: { lifetime_metrics: { IMPRESSION: n, ... }, summary_metrics: {...}, daily_metrics: [...] } }.

export const PIN_METRICS = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "REACTION", "COMMENTS", "VIDEO_MRC_VIEW", "VIDEO_AVG_WATCH_TIME", "TOTAL_VIDEO_AVG_WATCH_TIME"];
const num = (value) => (value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const day = (value) => new Date(value).toISOString().slice(0, 10);

export function analyticsPath(pinId, metric, publishedAt, now = Date.now()) {
  // Pinterest only reports the last 90 days; a pin is collected for 45, so the range always fits.
  const query = new URLSearchParams({ start_date: day(publishedAt), end_date: day(now), metric_types: metric, app_types: "ALL" });
  return `/pins/${encodeURIComponent(pinId)}/analytics?${query}`;
}

/** One number out of an analytics answer: the lifetime figure, else the summary, else the sum of the daily figures. */
export function metricValue(body, metric) {
  const all = body?.all || body;
  const lifetime = num(all?.lifetime_metrics?.[metric]);
  if (lifetime !== null) return lifetime;
  const summary = num(all?.summary_metrics?.[metric]);
  if (summary !== null) return summary;
  const daily = (all?.daily_metrics || []).map((d) => num(d?.metrics?.[metric])).filter((n) => n !== null);
  return daily.length ? daily.reduce((a, b) => a + b, 0) : null;
}

/** Snapshots for one due pin, one per bucket. A pin none of whose requests answered throws, so it is retried instead of saved as zeros. */
export async function collectForPin(item, call, now = Date.now()) {
  const answers = await Promise.all(PIN_METRICS.map(async (metric) => {
    try { return { metric, value: metricValue(await call("GET", analyticsPath(item.postId, metric, item.publishedAt, now)), metric) }; } catch (error) {
      return { metric, error: String(error?.message || error).slice(0, 200) };
    }
  }));
  const got = {};
  const raw = { analytics: {} };
  for (const a of answers) { raw.analytics[a.metric] = a.error ? { error: a.error } : a.value; if (!a.error) got[a.metric] = a.value; }
  const avgWatch = got.VIDEO_AVG_WATCH_TIME ?? got.TOTAL_VIDEO_AVG_WATCH_TIME ?? null;
  const metrics = {
    views: got.IMPRESSION ?? null,
    likes: got.REACTION ?? null,
    comments: got.COMMENTS ?? null,
    saves: got.SAVE ?? null,
    // Pinterest counts video watch time in milliseconds.
    avgViewDurationSeconds: avgWatch === null ? null : avgWatch / 1000,
    linkClicks: got.OUTBOUND_CLICK ?? null,
    shares: null, reach: null, watchTimeSeconds: null, followsGained: null
  };
  if (!Object.values(metrics).some((v) => v !== null)) throw new Error(`no Pinterest number came back for ${item.postId}: ${JSON.stringify(raw).slice(0, 300)}`);
  raw.pinClicks = got.PIN_CLICK ?? null;
  raw.videoViews = got.VIDEO_MRC_VIEW ?? null;
  return item.buckets.map((ageBucket) => ({ ledgerId: item.ledgerId, ageBucket, source: "pinterest-analytics", metrics, raw }));
}
