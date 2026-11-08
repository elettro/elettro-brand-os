import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshot, postsToVerify } from "../services/meta-lambda/metrics.mjs";
import { verifyMetrics as verifyMeta } from "../services/meta-lambda/index.mjs";
import { verifyMetrics as verifyThreads } from "../services/threads-lambda/index.mjs";
import { verifyMetrics as verifyPinterest } from "../services/pinterest-lambda/index.mjs";
import { verifyMetrics as verifyLinkedin } from "../services/linkedin-lambda/index.mjs";
import { runListPostMetrics } from "../services/dev-api-lambda/post-metrics.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const row = (over = {}) => ({ ledgerId: "a", externalPostId: "p1", externalUrl: "https://x/p1", brand: "stashbox", placement: "post", channelId: "c1", publishedAt: "2026-11-05T12:00:00Z", capturedAt: "2026-11-06T12:00:00Z", ageBucket: "24h", views: 10, likes: 1, comments: 0, ...over });

test("compareSnapshot lists the fields that differ and ignores ones neither side has", () => {
  const same = compareSnapshot(row(), { views: 10, likes: 1, comments: 0 });
  assert.deepEqual(same.differs, []);
  assert.equal(same.takenAfterHours, 24);
  const diff = compareSnapshot(row(), { views: 12, likes: 1, comments: 0, reach: 9 });
  assert.deepEqual(diff.differs, ["views", "reach"]);
  assert.deepEqual(diff.stored.views, 10);
  assert.deepEqual(diff.live.reach, 9);
  assert.ok(!("shares" in diff.stored));
});

test("only posts at least a day old, one snapshot each, never Stories, newest first, up to the limit", () => {
  const rows = [
    row({ ledgerId: "new", publishedAt: "2026-11-08T06:00:00Z" }),
    row({ ledgerId: "story", placement: "story" }),
    row({ ledgerId: "a" }), row({ ledgerId: "a", ageBucket: "1h" }),
    row({ ledgerId: "b" }), row({ ledgerId: "c" })
  ];
  assert.deepEqual(postsToVerify(rows, 2, NOW).map((r) => r.ledgerId), ["a", "b"]);
});

test("the snapshot viewer also returns the account id a worker needs", async () => {
  let sql = "";
  await runListPostMetrics({}, async () => ({ query: async (s) => { sql = s; return { rows: [] }; }, end: async () => {} }), (c, b) => ({ statusCode: c, body: b }));
  assert.match(sql, /sa\."externalAccountId" AS "channelId"/);
  assert.match(sql, /LEFT JOIN "SocialAccount" sa/);
});

test("each worker verifies stored numbers against the network and reports a post it cannot read", async () => {
  const rows = [row(), row({ ledgerId: "b", externalPostId: "p2", channelId: "bad" })];
  const callApi = async () => ({ ok: true, rows });
  const meta = await verifyMeta({}, { callApi, find: async (d, id) => { if (id === "bad") throw new Error("No instagram login"); return { pageAccessToken: "t" }; },
    call: async (m, path, params) => (params.metric ? { data: [{ name: params.metric, values: [{ value: 10 }] }] } : { like_count: 1, comments_count: 0 }) });
  assert.ok(meta.some((r) => r.destination === "instagram" && r.stored && r.live));
  assert.ok(meta.some((r) => r.error && /No instagram login/.test(r.error)));
  const threads = await verifyThreads({}, { callApi, find: async (b, id) => { if (id === "bad") throw new Error("expired"); return { accessToken: "t" }; },
    call: async () => ({ data: [{ name: "views", values: [{ value: 10 }] }, { name: "likes", values: [{ value: 1 }] }, { name: "replies", values: [{ value: 0 }] }] }) });
  assert.deepEqual(threads[0].differs, []);
  assert.match(threads[1].error, /expired/);
  const pin = await verifyPinterest({}, { callApi, find: async () => ({ accessToken: "t" }), call: async () => ({ all: { lifetime_metrics: { IMPRESSION: 11 } } }) });
  assert.ok(pin[0].differs.includes("views"));
  const li = await verifyLinkedin({}, { callApi, find: async () => ({ accessToken: "t" }),
    call: async () => ({ elements: [{ ugcPost: "urn:li:ugcPost:5", totalShareStatistics: { impressionCount: 10 } }] }) });
  assert.match(li[0].error, /no statistics|returned no/i);
});
