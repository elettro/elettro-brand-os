import test from "node:test";
import assert from "node:assert/strict";
import { runListPostMetrics } from "../services/dev-api-lambda/post-metrics.mjs";

const json = (statusCode, body) => ({ statusCode, body });

test("the snapshot viewer refuses anything that came through HTTP", async () => {
  const answer = await runListPostMetrics({ requestContext: {} }, async () => { throw new Error("must not connect"); }, json);
  assert.equal(answer.statusCode, 403);
});

test("the snapshot viewer filters by brand, network, ledger id or post id, caps the limit, and returns the raw answers", async () => {
  const seen = [];
  const connect = async () => ({ query: async (sql, params) => { seen.push([sql, params]); return { rows: [{ brand: "stashbox", destination: "youtube", ageBucket: "7d", comments: 3, raw: { statistics: { commentCount: "0" } } }] }; }, end: async () => {} });
  const answer = await runListPostMetrics({ brand: "stashbox", destination: "youtube", externalPostId: "abc", limit: 500 }, connect, json);
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.count, 1);
  assert.equal(answer.body.rows[0].raw.statistics.commentCount, "0");
  const [sql, params] = seen[0];
  assert.match(sql, /pm\."raw"/);
  assert.match(sql, /FROM "PostMetric" pm JOIN "PublicationLedger"/);
  assert.deepEqual(params, ["stashbox", "youtube", null, "abc", 100]);
  assert.equal((await runListPostMetrics({}, connect, json)).statusCode, 200);
  assert.equal(seen[1][1][4], 20);
});
