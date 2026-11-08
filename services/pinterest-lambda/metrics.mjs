// Pinterest pin metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only. Scope: pins:read.
//
// `GET /v5/pins/{id}/analytics` takes a date range and a list of metrics, and refuses the whole request when one metric does not suit
// the pin (video metrics on an image pin, for one). So each metric is its own request: an unsuitable one costs only itself and its
// error is kept in `raw`. Pinterest answers { all: { lifetime_metrics: { IMPRESSION: n, ... }, summary_metrics: {...}, daily_metrics: [...] } }.

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

// Pinterest rate-limits analytics hard (nine single-metric requests per pin tripped it on 2026-11-07), so the metrics go out in
// one request per group, and only a refused group is retried one metric at a time.
const CORE_GROUP = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "REACTION", "COMMENTS"];
const VIDEO_GROUP = ["VIDEO_MRC_VIEW", "VIDEO_AVG_WATCH_TIME"];
const RATE_LIMITED = /rate limit|too many requests|429/i;

async function askGroup(item, group, call, now, got, raw) {
  const read = (body, names) => { for (const metric of names) { const value = metricValue(body, metric); raw.analytics[metric] = value; if (value !== null) got[metric] = value; } };
  try {
    read(await call("GET", analyticsPath(item.postId, group.join(","), item.publishedAt, now)), group);
    return;
  } catch (error) {
    // A rate limit would only repeat for every single metric: leave it for the next tick.
    if (RATE_LIMITED.test(String(error?.message))) { for (const metric of group) raw.analytics[metric] = { error: String(error.message).slice(0, 200) }; return; }
  }
  for (const metric of group) {
    try { read(await call("GET", analyticsPath(item.postId, metric, item.publishedAt, now)), [metric]); } catch (error) { raw.analytics[metric] = { error: String(error?.message || error).slice(0, 200) }; }
  }
}

/** Snapshots for one due pin, one per bucket. A pin none of whose requests answered throws, so it is retried instead of saved as zeros. */
export async function collectForPin(item, call, now = Date.now()) {
  const got = {};
  const raw = { analytics: {} };
  await askGroup(item, CORE_GROUP, call, now, got, raw);
  if (item.placement === "video") {
    await askGroup(item, VIDEO_GROUP, call, now, got, raw);
    // The first snapshot wins, so a video pin is not saved without its watch time just because Pinterest asked us to slow down.
    const limited = raw.analytics.VIDEO_MRC_VIEW;
    if (limited && typeof limited === "object" && RATE_LIMITED.test(limited.error || "")) throw new Error(`Pinterest rate limit on ${item.postId}; retry next tick`);
  }
  const avgWatch = got.VIDEO_AVG_WATCH_TIME ?? null;
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
