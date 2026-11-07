import test from "node:test";
import assert from "node:assert/strict";
import { AGE_BUCKETS, dueBuckets, cleanMetricItem, runPostMetricsSetup, runListPostMetricsDue, runRecordPostMetrics } from "../services/dev-api-lambda/post-metrics.mjs";
import { analyticsUrl, statisticsUrl, snapshotFrom, collectForVideo } from "../services/youtube-upload-lambda/metrics.mjs";

const HOUR = 3600000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const LEDGER = "123e4567-e89b-12d3-a456-426614174000";
const json = (statusCode, body) => ({ statusCode, body });

test("a post is due for each age bucket it has reached and not yet captured", () => {
  const published = new Date(NOW - 30 * HOUR).toISOString();
  assert.deepEqual(dueBuckets(published, [], NOW), ["1h", "24h"]);
  assert.deepEqual(dueBuckets(published, ["1h"], NOW), ["24h"]);
  assert.deepEqual(dueBuckets(new Date(NOW - 10 * 60000).toISOString(), [], NOW), []);
  assert.deepEqual(dueBuckets(new Date(NOW - 8 * 24 * HOUR).toISOString(), ["1h", "24h"], NOW), ["7d"]);
});

test("a post older than 45 days or published in the future is not collected", () => {
  assert.deepEqual(dueBuckets(new Date(NOW - 46 * 24 * HOUR).toISOString(), [], NOW), []);
  assert.deepEqual(dueBuckets(new Date(NOW + HOUR).toISOString(), [], NOW), []);
  assert.deepEqual(AGE_BUCKETS.map((b) => b.id), ["1h", "24h", "7d", "30d"]);
});

test("cleanMetricItem keeps whole numbers, nulls the missing and refuses bad ids and buckets", () => {
  const row = cleanMetricItem({ ledgerId: LEDGER, ageBucket: "7d", source: "analytics", metrics: { views: "12.4", likes: 3, watchTimeSeconds: 90.6, avgViewDurationSeconds: 21.5 } });
  assert.equal(row.views, 12);
  assert.equal(row.comments, null);
  assert.equal(row.watchTimeSeconds, 91);
  assert.equal(row.avgViewDurationSeconds, 21.5);
  assert.throws(() => cleanMetricItem({ ledgerId: "nope", ageBucket: "7d", source: "x" }), /uuid/);
  assert.throws(() => cleanMetricItem({ ledgerId: LEDGER, ageBucket: "2h", source: "x" }), /ageBucket/);
  assert.throws(() => cleanMetricItem({ ledgerId: LEDGER, ageBucket: "1h" }), /source/);
});

test("the three dev-api actions refuse anything that came through HTTP", async () => {
  for (const run of [runPostMetricsSetup, runListPostMetricsDue, runRecordPostMetrics]) {
    const answer = await run({ requestContext: {} }, async () => { throw new Error("must not connect"); }, json);
    assert.equal(answer.statusCode, 403);
  }
});

test("setup is a dry run unless mode is apply", async () => {
  const calls = [];
  const connect = async () => ({ query: async (sql) => { calls.push(sql); return { rows: [] }; }, end: async () => {} });
  const dry = await runPostMetricsSetup({}, connect, json);
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.mode, "dry-run");
  assert.ok(!calls.some((sql) => /CREATE TABLE/.test(sql)));
  const applied = await runPostMetricsSetup({ mode: "apply" }, connect, json);
  assert.equal(applied.body.mode, "apply");
  assert.ok(calls.some((sql) => /CREATE TABLE IF NOT EXISTS "PostMetric"/.test(sql)));
});

test("the due list returns only posts with a bucket to capture, plus the channels", async () => {
  const connect = async () => ({
    query: async (sql) => /FROM "SocialAccount" sa JOIN/.test(sql)
      ? { rows: [{ brand: "stashbox", accountName: "@stashboxband", channelId: "UC6C6Z_erONmKW67pF5AyYkA" }] }
      : { rows: [
        { ledgerId: "a", videoId: "v1", publishedAt: new Date(NOW - 30 * HOUR), channelId: "UC1", brand: "stashbox", captured: ["1h", "24h"] },
        { ledgerId: "b", videoId: "v2", publishedAt: new Date(NOW - 30 * HOUR), channelId: "UC1", brand: "stashbox", captured: ["1h"] }
      ] },
    end: async () => {}
  });
  const answer = await runListPostMetricsDue({}, connect, json, NOW);
  assert.equal(answer.body.channels.length, 1);
  assert.deepEqual(answer.body.due.map((d) => [d.videoId, d.buckets]), [["v2", ["24h"]]]);
  assert.equal((await runListPostMetricsDue({ destination: "tiktok" }, connect, json, NOW)).statusCode, 400);
});

test("record saves new snapshots and leaves an existing one alone", async () => {
  const connect = async () => ({ query: async () => ({ rowCount: 0 }), end: async () => {} });
  const answer = await runRecordPostMetrics({ items: [{ ledgerId: LEDGER, ageBucket: "1h", source: "statistics", metrics: { views: 5 } }] }, connect, json);
  assert.deepEqual([answer.body.saved, answer.body.skipped], [0, 1]);
  assert.equal((await runRecordPostMetrics({ items: [] }, connect, json)).statusCode, 400);
});

test("report URLs: one video from its publish day, or the channel for 28 days", () => {
  const one = new URL(analyticsUrl({ videoId: "abc123", publishedAt: "2026-11-01T15:00:00Z", now: NOW }));
  assert.equal(one.searchParams.get("filters"), "video==abc123");
  assert.equal(one.searchParams.get("startDate"), "2026-11-01");
  assert.equal(one.searchParams.get("endDate"), "2026-11-10");
  assert.equal(one.searchParams.get("ids"), "channel==MINE");
  const channel = new URL(analyticsUrl({ now: NOW }));
  assert.equal(channel.searchParams.get("filters"), null);
  assert.equal(channel.searchParams.get("startDate"), "2026-10-13");
  assert.match(statisticsUrl("abc123"), /part=statistics&id=abc123/);
});

test("snapshotFrom prefers Analytics, converts minutes to seconds and falls back to Data API counts", () => {
  const statistics = { items: [{ statistics: { viewCount: "40", likeCount: "5", commentCount: "2" } }] };
  const headers = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "subscribersGained"].map((name) => ({ name }));
  const both = snapshotFrom(statistics, { columnHeaders: headers, rows: [[38, 12.5, 20, 4, 1, 3, 2]] });
  assert.equal(both.source, "analytics");
  assert.deepEqual(both.metrics, { views: 38, likes: 4, comments: 1, shares: 3, watchTimeSeconds: 750, avgViewDurationSeconds: 20, followsGained: 2 });
  const only = snapshotFrom(statistics, { columnHeaders: headers, rows: [] });
  assert.equal(only.source, "statistics");
  assert.deepEqual([only.metrics.views, only.metrics.likes, only.metrics.shares, only.metrics.watchTimeSeconds], [40, 5, null, null]);
});

test("collectForVideo keeps the Data API numbers when Analytics is refused, and nothing for a missing video", async (t) => {
  const answers = [
    { ok: true, status: 200, json: async () => ({ items: [{ statistics: { viewCount: "9", likeCount: "1", commentCount: "0" } }] }) },
    { ok: false, status: 403, json: async () => ({ error: { message: "Insufficient Permission" } }) }
  ];
  t.mock.method(globalThis, "fetch", async () => answers.shift());
  const out = await collectForVideo({ ledgerId: "a", videoId: "v", publishedAt: new Date(NOW - 30 * HOUR).toISOString(), buckets: ["1h", "24h"] }, "token", NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "statistics");
  assert.equal(out[0].metrics.views, 9);
  assert.equal(out[0].raw.analytics.error, 403);
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  assert.deepEqual(await collectForVideo({ ledgerId: "a", videoId: "v", publishedAt: "2026-11-01T00:00:00Z", buckets: ["1h"] }, "token", NOW), []);
});
