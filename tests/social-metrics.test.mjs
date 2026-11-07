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
  assert.deepEqual(METRIC_DESTINATIONS, ["youtube", "instagram", "facebook", "threads"]);
  const seen = [];
  const connect = async () => ({ query: async (sql, params) => { seen.push([sql, params]); return { rows: [] }; }, end: async () => {} });
  for (const destination of METRIC_DESTINATIONS) assert.equal((await runListPostMetricsDue({ destination }, connect, json, NOW)).statusCode, 200);
  assert.equal((await runListPostMetricsDue({ destination: "tiktok" }, connect, json, NOW)).statusCode, 400);
  const ledger = seen.filter(([sql]) => /FROM "PublicationLedger"/.test(sql)).at(-1);
  assert.equal(ledger[1][0], "threads");
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
