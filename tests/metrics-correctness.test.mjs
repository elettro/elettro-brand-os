import test from "node:test";
import assert from "node:assert/strict";
import { statsFromMetric } from "../services/dev-api-lambda/calendar.mjs";
import { runRecomputeYoutubeMetrics } from "../services/dev-api-lambda/post-metrics.mjs";

const json = (statusCode, body) => ({ statusCode, body });

test("the panel reports how long after posting a snapshot was really taken, not the bucket it filled", () => {
  const row = { ageBucket: "1h", source: "analytics", views: 1283, capturedAt: "2026-11-07T19:58:10.335Z" };
  const stats = statsFromMetric(row, "2026-10-29T14:13:13.303Z");
  assert.equal(stats.asOf, "1h");
  assert.equal(stats.takenAfterHours, 221.7);
  assert.equal(statsFromMetric({ ...row, capturedAt: "2026-10-29T14:40:00Z" }, "2026-10-29T14:13:13.303Z").takenAfterHours, 0.4);
  // Unknown or impossible times leave the field out rather than guess.
  assert.equal("takenAfterHours" in statsFromMetric(row, null), false);
  assert.equal("takenAfterHours" in statsFromMetric(row, "2026-12-01T00:00:00Z"), false);
  assert.equal("takenAfterHours" in statsFromMetric({ ageBucket: "1h", source: "x", views: 1 }, "2026-10-29T14:13:13Z"), false);
});

test("the YouTube recompute refuses HTTP, is a dry run by default, and only touches YouTube Analytics rows", async () => {
  assert.equal((await runRecomputeYoutubeMetrics({ requestContext: {} }, async () => { throw new Error("no"); }, json)).statusCode, 403);
  const calls = [];
  const connect = async () => ({ query: async (sql) => { calls.push(sql); return /count\(\*\)/.test(sql) ? { rows: [{ n: 7 }] } : { rowCount: 7 }; }, end: async () => {} });
  const dry = await runRecomputeYoutubeMetrics({}, connect, json);
  assert.deepEqual([dry.body.mode, dry.body.wouldChange], ["dry-run", 7]);
  assert.ok(!calls.some((sql) => /UPDATE/.test(sql)));
  const applied = await runRecomputeYoutubeMetrics({ mode: "apply" }, connect, json);
  assert.equal(applied.body.changed, 7);
  const update = calls.find((sql) => /UPDATE "PostMetric"/.test(sql));
  assert.match(update, /pm\."source" = 'analytics'/);
  assert.match(update, /pl\."destination" = 'youtube'/);
  assert.match(update, /COALESCE\(\(pm\."raw" #>> '\{statistics,commentCount\}'\)::int, pm\."comments"\)/);
});
