import test from "node:test";
import assert from "node:assert/strict";
import { insightValue, instagramSnapshot, facebookSnapshot, collectForPost } from "../services/meta-lambda/metrics.mjs";
import { snapshotFrom, collectForPost as collectThreads } from "../services/threads-lambda/metrics.mjs";
import { collectMetrics as collectMeta } from "../services/meta-lambda/index.mjs";
import { collectMetrics as collectThreadsAll } from "../services/threads-lambda/index.mjs";
import { runListPostMetricsDue, cleanMetricItem, METRIC_DESTINATIONS, POST_METRIC_TABLES_SQL } from "../services/dev-api-lambda/post-metrics.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3600000;
const LEDGER = "123e4567-e89b-12d3-a456-426614174000";
const json = (statusCode, body) => ({ statusCode, body });
const value = (name, v) => ({ data: [{ name, values: [{ value: v }] }] });

// A fake Graph call: answers by the metric asked for; a missing key throws like Meta does.
const fakeGraph = (answers, fields = {}) => async (method, path, params) => {
  if (params.metric) {
    if (!(params.metric in answers)) throw new Error(`Meta ${path} failed: (#100) metric not supported`);
    return value(params.metric, answers[params.metric]);
  }
  return fields;
};

test("insightValue reads both answer shapes and ignores breakdown objects", () => {
  assert.equal(insightValue(value("views", 12)), 12);
  assert.equal(insightValue({ data: [{ name: "views", total_value: { value: 7 } }] }), 7);
  assert.equal(insightValue({ data: [{ name: "x", values: [{ value: { a: 1 } }] }] }), null);
  assert.equal(insightValue({ data: [] }), null);
});

test("an Instagram Reel snapshot maps views, reach, saves and converts watch time from milliseconds", async () => {
  const call = fakeGraph({ views: 100, reach: 80, likes: 9, comments: 2, shares: 3, saved: 4, ig_reels_avg_watch_time: 4500, ig_reels_video_view_total_time: 90000 });
  const { metrics } = await instagramSnapshot({ postId: "m1", placement: "reel" }, "t", call);
  assert.deepEqual(metrics, { views: 100, reach: 80, likes: 9, comments: 2, shares: 3, saves: 4, watchTimeSeconds: 90, avgViewDurationSeconds: 4.5, followsGained: null });
});

test("an Instagram photo asks no watch-time numbers and falls back to the media's own like and comment counts", async () => {
  const asked = [];
  const call = async (method, path, params) => {
    if (params.metric) { asked.push(params.metric); if (params.metric === "views") return value("views", 50); throw new Error("not supported"); }
    return { like_count: 6, comments_count: 1 };
  };
  const { metrics, raw } = await instagramSnapshot({ postId: "m2", placement: "post" }, "t", call);
  assert.ok(!asked.some((m) => m.startsWith("ig_reels")));
  assert.equal(metrics.views, 50);
  assert.equal(metrics.likes, 6);
  assert.equal(metrics.comments, 1);
  assert.equal(metrics.reach, null);
  assert.match(raw.insights.reach.error, /not supported/);
});

test("a Facebook photo post uses post insights and the object's counts; a Reel uses video insights", async () => {
  const post = await facebookSnapshot({ postId: "p1", placement: "post" }, "t",
    fakeGraph({ post_media_view: 30, post_total_media_view_unique: 22 }, { reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } }));
  assert.deepEqual([post.metrics.views, post.metrics.reach, post.metrics.likes, post.metrics.comments, post.metrics.shares], [30, 22, 5, 1, 2]);
  const paths = [];
  const reel = await facebookSnapshot({ postId: "v1", placement: "reel" }, "t", async (m, path, params) => {
    paths.push(path);
    return params.metric ? value(params.metric, { total_video_views: 200, total_video_avg_time_watched: 3000, total_video_view_total_time: 600000 }[params.metric]) : { likes: { summary: { total_count: 8 } }, comments: { summary: { total_count: 0 } } };
  });
  assert.ok(paths.includes("v1/video_insights"));
  assert.deepEqual([reel.metrics.views, reel.metrics.watchTimeSeconds, reel.metrics.avgViewDurationSeconds, reel.metrics.likes], [200, 600, 3, 8]);
});

test("a post none of whose requests answered throws instead of saving zeros", async () => {
  const dead = async () => { throw new Error("Meta failed: (#10) permission"); };
  await assert.rejects(() => collectForPost("instagram", { postId: "m", placement: "post", buckets: ["1h"] }, "t", dead), /no instagram number came back/);
  const out = await collectForPost("facebook", { ledgerId: "a", postId: "p", placement: "post", buckets: ["1h", "24h"] }, "t", fakeGraph({ post_media_view: 1 }));
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "facebook-insights");
});

test("Threads: replies are comments, reposts and quotes add up to shares, absent numbers stay null", () => {
  const { metrics } = snapshotFrom({ data: [
    { name: "views", values: [{ value: 40 }] }, { name: "likes", values: [{ value: 5 }] }, { name: "replies", values: [{ value: 2 }] },
    { name: "reposts", values: [{ value: 1 }] }, { name: "quotes", values: [{ value: 2 }] }] });
  assert.deepEqual([metrics.views, metrics.likes, metrics.comments, metrics.shares, metrics.reach], [40, 5, 2, 3, null]);
  assert.equal(snapshotFrom({ data: [{ name: "views", values: [{ value: 1 }] }] }).metrics.shares, null);
});

test("Threads collect throws when Threads answers nothing usable", async () => {
  await assert.rejects(() => collectThreads({ ledgerId: "a", postId: "t1", buckets: ["1h"] }, "tok", async () => ({ data: [] })), /no Threads number/);
  const out = await collectThreads({ ledgerId: "a", postId: "t1", buckets: ["1h", "7d"] }, "tok", async () => ({ data: [{ name: "views", values: [{ value: 3 }] }] }));
  assert.deepEqual(out.map((o) => o.ageBucket), ["1h", "7d"]);
  assert.equal(out[0].source, "threads-insights");
});

test("the Meta worker saves per network, survives one failing post, and a dry run saves nothing", async () => {
  const recorded = [];
  const callApi = async (payload) => {
    if (payload.action === "list-post-metrics-due-20261107") {
      return { ok: true, due: payload.destination === "instagram"
        ? [{ ledgerId: "a", postId: "m1", placement: "post", channelId: "IG1", brand: "stashbox", buckets: ["1h"] }, { ledgerId: "b", postId: "m2", placement: "post", channelId: "IGX", brand: "stashbox", buckets: ["1h"] }]
        : [] };
    }
    recorded.push(...payload.items);
    return { ok: true, saved: payload.items.length };
  };
  const find = async (destination, channelId) => { if (channelId === "IGX") throw new Error("No instagram login is connected"); return { pageAccessToken: "tok" }; };
  const call = fakeGraph({ views: 10 });
  const done = await collectMeta({}, { callApi, call, find });
  assert.equal(done.saved, 1);
  assert.equal(done.failures.length, 1);
  assert.equal(recorded[0].ledgerId, "a");
  recorded.length = 0;
  const dry = await collectMeta({ dryRun: true }, { callApi, call, find });
  assert.equal(recorded.length, 0);
  assert.equal(dry.samples.length, 1);
});

test("the Threads worker saves what it collects", async () => {
  const recorded = [];
  const callApi = async (payload) => payload.action === "list-post-metrics-due-20261107"
    ? { ok: true, due: [{ ledgerId: "a", postId: "t1", channelId: "U1", brand: "stashbox", buckets: ["24h"] }] }
    : (recorded.push(...payload.items), { ok: true, saved: payload.items.length });
  const out = await collectThreadsAll({}, { callApi, find: async () => ({ accessToken: "x" }), call: async () => ({ data: [{ name: "views", values: [{ value: 9 }] }] }) });
  assert.equal(out.saved, 1);
  assert.equal(recorded[0].metrics.views, 9);
});

test("dev-api: due list takes each collected network, skips Stories, refuses the rest", async () => {
  assert.deepEqual(METRIC_DESTINATIONS, ["youtube", "instagram", "facebook", "threads", "pinterest", "bluesky", "mastodon", "linkedin"]);
  const seen = [];
  const connect = async () => ({ query: async (sql, params) => { seen.push([sql, params]); return { rows: [] }; }, end: async () => {} });
  for (const destination of METRIC_DESTINATIONS) assert.equal((await runListPostMetricsDue({ destination }, connect, json, NOW)).statusCode, 200);
  assert.equal((await runListPostMetricsDue({ destination: "tiktok" }, connect, json, NOW)).statusCode, 400);
  const ledger = seen.filter(([sql]) => /FROM "PublicationLedger"/.test(sql)).at(-1);
  assert.equal(ledger[1][0], "linkedin");
  assert.ok(ledger[1].some((p) => Array.isArray(p) && p.includes("story")));
  assert.match(ledger[0], /COALESCE\(pl\."placement"::text, ''\) <> ALL/);
});

test("reach and saves are kept, and setup adds the columns to an existing table", () => {
  const row = cleanMetricItem({ ledgerId: LEDGER, ageBucket: "1h", source: "instagram-insights", metrics: { reach: "80.2", saves: 4, views: 10 } });
  assert.equal(row.reach, 80);
  assert.equal(row.saves, 4);
  assert.equal(cleanMetricItem({ ledgerId: LEDGER, ageBucket: "1h", source: "x", metrics: {} }).reach, null);
  assert.ok(POST_METRIC_TABLES_SQL.some((s) => /ADD COLUMN IF NOT EXISTS "reach"/.test(s)));
  assert.ok(POST_METRIC_TABLES_SQL.some((s) => /ADD COLUMN IF NOT EXISTS "saves"/.test(s)));
});

test("Facebook: a photo's id is swapped for its post id, and an id with no such field is read as a video", async () => {
  const asked = [];
  const photo = await facebookSnapshot({ postId: "555", placement: "post" }, "t", async (m, path, params) => {
    asked.push(path);
    if (params.fields === "page_story_id") return { page_story_id: "9_555" };
    return params.metric ? value(params.metric, 7) : {};
  });
  assert.ok(asked.includes("9_555/insights"));
  assert.equal(photo.metrics.views, 7);
  const paths = [];
  const video = await facebookSnapshot({ postId: "777", placement: "post" }, "t", async (m, path, params) => {
    paths.push(path);
    if (params.fields === "page_story_id") throw new Error("(#100) Tried accessing nonexisting field (page_story_id)");
    return params.metric ? value(params.metric, params.metric === "fb_reels_total_plays" ? 40 : 1) : {};
  });
  assert.ok(paths.includes("777/video_insights"));
  assert.equal(video.metrics.views, 40);
});

test("Pinterest: lifetime numbers map to views, saves and link clicks; an unsuitable metric costs only itself", async () => {
  const { collectForPin, metricValue, analyticsPath } = await import("../services/pinterest-lambda/metrics.mjs");
  assert.equal(metricValue({ all: { lifetime_metrics: { SAVE: 3 } } }, "SAVE"), 3);
  assert.equal(metricValue({ all: { daily_metrics: [{ metrics: { SAVE: 1 } }, { metrics: { SAVE: 2 } }] } }, "SAVE"), 3);
  assert.equal(metricValue({ all: {} }, "SAVE"), null);
  const url = new URL("https://x" + analyticsPath("123", "IMPRESSION", "2026-11-01T15:00:00Z", Date.parse("2026-11-10T12:00:00Z")));
  assert.deepEqual([url.searchParams.get("start_date"), url.searchParams.get("end_date"), url.searchParams.get("metric_types")], ["2026-11-01", "2026-11-10", "IMPRESSION"]);
  const values = { IMPRESSION: 120, SAVE: 4, OUTBOUND_CLICK: 6, PIN_CLICK: 9, VIDEO_AVG_WATCH_TIME: 5000 };
  const requests = [];
  // Like Pinterest: the whole group answers, or a 400 when one metric does not suit the pin.
  const call = async (m, path) => {
    const asked = new URL("https://x" + path).searchParams.get("metric_types").split(",");
    requests.push(asked.length);
    if (asked.length > 1 && asked.some((metric) => !(metric in values) && metric !== "REACTION" && metric !== "COMMENTS")) throw new Error("Pinterest GET failed: metric not valid");
    const lifetime = {};
    for (const metric of asked) if (metric in values) lifetime[metric] = values[metric];
    return { all: { lifetime_metrics: lifetime } };
  };
  const out = await collectForPin({ ledgerId: "a", postId: "123", placement: "pin", publishedAt: "2026-11-01T15:00:00Z", buckets: ["1h", "24h"] }, call, Date.parse("2026-11-10T12:00:00Z"));
  assert.deepEqual(requests, [6]);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].metrics.views, out[0].metrics.saves, out[0].metrics.linkClicks, out[0].metrics.likes], [120, 4, 6, null]);
  const video = await collectForPin({ ledgerId: "a", postId: "124", placement: "video", publishedAt: "2026-11-01T15:00:00Z", buckets: ["1h"] }, call, Date.parse("2026-11-10T12:00:00Z"));
  assert.equal(video[0].metrics.avgViewDurationSeconds, 5);
  const limited = async () => { throw new Error("Pinterest GET failed: You have exceeded your rate limit. Try again later."); };
  await assert.rejects(() => collectForPin({ ledgerId: "a", postId: "9", placement: "pin", publishedAt: "2026-11-01T00:00:00Z", buckets: ["1h"] }, limited), /no Pinterest number/);
  assert.equal(out[0].raw.pinClicks, 9);
  await assert.rejects(() => collectForPin({ ledgerId: "a", postId: "1", publishedAt: "2026-11-01T00:00:00Z", buckets: ["1h"] }, async () => { throw new Error("401"); }), /no Pinterest number/);
});

test("the Pinterest worker saves what it collects and a dry run saves nothing", async () => {
  const { collectMetrics } = await import("../services/pinterest-lambda/index.mjs");
  const recorded = [];
  const callApi = async (p) => p.action === "list-post-metrics-due-20261107"
    ? { ok: true, due: [{ ledgerId: "a", postId: "9", publishedAt: new Date(Date.now() - 30 * HOUR).toISOString(), channelId: "12345", brand: "stashbox", buckets: ["1h"] }] }
    : (recorded.push(...p.items), { ok: true, saved: p.items.length });
  const deps = { callApi, find: async () => ({ accessToken: "t" }), call: async () => ({ all: { lifetime_metrics: { IMPRESSION: 5 } } }) };
  assert.equal((await collectMetrics({ dryRun: true }, deps)).samples.length, 1);
  assert.equal(recorded.length, 0);
  assert.equal((await collectMetrics({}, deps)).saved, 1);
  assert.equal(recorded[0].metrics.views, 5);
});

test("linkClicks is kept and added by setup", () => {
  assert.equal(cleanMetricItem({ ledgerId: LEDGER, ageBucket: "1h", source: "pinterest-analytics", metrics: { linkClicks: "6" } }).linkClicks, 6);
  assert.ok(POST_METRIC_TABLES_SQL.some((s) => /ADD COLUMN IF NOT EXISTS "linkClicks"/.test(s)));
});

test("Bluesky: counts come from the public AppView in batches of 25, a missing post is left for next tick", async () => {
  const { collectForPosts, metricsFromPost, postsUrl } = await import("../services/bluesky-lambda/metrics.mjs");
  assert.deepEqual(metricsFromPost({ likeCount: 5, replyCount: 1, repostCount: 2, quoteCount: 1 }), { views: null, reach: null, saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null, likes: 5, comments: 1, shares: 3 });
  assert.equal(metricsFromPost({}).shares, null);
  const items = Array.from({ length: 30 }, (_, i) => ({ ledgerId: `l${i}`, postId: `at://did:plc:x/app.bsky.feed.post/${i}`, buckets: i === 0 ? ["1h", "24h"] : ["1h"] }));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const uris = new URL(url).searchParams.getAll("uris");
    return { ok: true, status: 200, json: async () => ({ posts: uris.filter((u) => !u.endsWith("/7")).map((uri) => ({ uri, likeCount: 2, replyCount: 0, repostCount: 0, quoteCount: 0 })) }) };
  };
  const { snapshots, missing } = await collectForPosts(items, fetchImpl);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.getAll("uris").length, 25);
  assert.deepEqual(missing, ["at://did:plc:x/app.bsky.feed.post/7"]);
  assert.equal(snapshots.length, 30);
  assert.equal(snapshots[0].source, "bluesky-appview");
  await assert.rejects(() => collectForPosts(items.slice(0, 1), async () => ({ ok: false, status: 502, json: async () => ({}) })), /getPosts failed/);
  assert.match(postsUrl(["at://a/b/1"]), /uris=at%3A%2F%2Fa%2Fb%2F1/);
});

test("Mastodon: counts come from the post's own instance, and a refused status throws", async () => {
  const { collectForStatus, instanceOf, metricsFromStatus } = await import("../services/mastodon-lambda/metrics.mjs");
  assert.equal(instanceOf("https://mastodon.social/@stashbox/111"), "https://mastodon.social");
  assert.equal(instanceOf("nope"), null);
  assert.deepEqual([metricsFromStatus({ favourites_count: 4, replies_count: 1, reblogs_count: 2 }).likes, metricsFromStatus({}).likes], [4, null]);
  const seen = [];
  const ok = async (url) => (seen.push(url), { ok: true, status: 200, json: async () => ({ favourites_count: 4, replies_count: 1, reblogs_count: 2 }) });
  const out = await collectForStatus({ ledgerId: "a", postId: "111", externalUrl: "https://mastodon.social/@s/111", buckets: ["1h", "24h"] }, ok);
  assert.equal(seen[0], "https://mastodon.social/api/v1/statuses/111");
  assert.deepEqual([out.length, out[0].metrics.likes, out[0].metrics.comments, out[0].metrics.shares], [2, 4, 1, 2]);
  await assert.rejects(() => collectForStatus({ ledgerId: "a", postId: "1", externalUrl: "https://mastodon.social/x", buckets: ["1h"] }, async () => ({ ok: false, status: 404, json: async () => ({ error: "Record not found" }) })), /Record not found/);
  await assert.rejects(() => collectForStatus({ ledgerId: "a", postId: "1", buckets: ["1h"] }), /no instance address/);
});

test("the Bluesky and Mastodon workers save what they collect; a dry run saves nothing", async () => {
  const bsky = await import("../services/bluesky-lambda/index.mjs");
  const masto = await import("../services/mastodon-lambda/index.mjs");
  const recorded = [];
  const mk = (due) => async (p) => p.action === "list-post-metrics-due-20261107" ? { ok: true, due } : (recorded.push(...p.items), { ok: true, saved: p.items.length });
  const snap = (item) => [{ ledgerId: item.ledgerId, ageBucket: item.buckets[0], source: "x", metrics: { likes: 1 }, raw: {} }];
  const due = [{ ledgerId: "a", postId: "p", buckets: ["1h"], brand: "stashbox" }];
  assert.equal((await bsky.collectMetrics({ dryRun: true }, { callApi: mk(due), collect: async (items) => ({ snapshots: items.flatMap(snap), missing: [] }) })).saved, 0);
  assert.equal(recorded.length, 0);
  assert.equal((await bsky.collectMetrics({}, { callApi: mk(due), collect: async (items) => ({ snapshots: items.flatMap(snap), missing: [] }) })).saved, 1);
  assert.equal((await masto.collectMetrics({}, { callApi: mk(due), collect: async (item) => snap(item) })).saved, 1);
  assert.equal((await masto.collectMetrics({ dryRun: true }, { callApi: mk(due), collect: async () => { throw new Error("gone"); } })).failures.length, 1);
});

test("the due list is newest first, so a post the network never answers for cannot hold up newer ones", async () => {
  const seen = [];
  const connect = async () => ({ query: async (sql) => { seen.push(sql); return { rows: [] }; }, end: async () => {} });
  await runListPostMetricsDue({ destination: "linkedin" }, connect, json, NOW);
  const ledger = seen.find((sql) => /FROM "PublicationLedger"/.test(sql));
  assert.match(ledger, /ORDER BY pl\."publishedAt" DESC/);
  // And the limit is applied after the buckets are worked out, to the newest first.
  const rows = [30, 10, 5].map((hours, i) => ({ ledgerId: `l${i}`, videoId: `v${i}`, publishedAt: new Date(NOW - hours * HOUR), channelId: "c", brand: "stashbox", captured: [], placement: "post" }));
  const newestFirst = [...rows].reverse();
  const answer = await runListPostMetricsDue({ destination: "linkedin", limit: 1 }, async () => ({ query: async (sql) => (/FROM "SocialAccount" sa JOIN/.test(sql) ? { rows: [] } : { rows: newestFirst }), end: async () => {} }), json, NOW);
  assert.equal(answer.body.due.length, 1);
  assert.equal(answer.body.due[0].videoId, "v2");
});
