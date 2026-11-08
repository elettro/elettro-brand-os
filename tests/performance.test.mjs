import test from "node:test";
import assert from "node:assert/strict";
import { computePerformance, lengthBucket, log2Lift, shrink, runPerformance, SHRINK_K } from "../services/dev-api-lambda/performance.mjs";

const NOW = new Date("2026-12-20T12:00:00Z");
const DAY = 864e5;
// A snapshot taken on time for its bucket.
const snap = (i, over = {}) => {
  const published = new Date(NOW.getTime() - (5 + i) * DAY).toISOString();
  return { ledgerId: `l${i}`, socialAccountId: "acct", accountName: "@stashboxband", destination: "youtube", placement: "short", publishedAt: published,
    sector: i % 2 ? "live-shows" : "merch", durationMs: 20000, assetId: `a${i % 5}`, title: `Clip ${i % 5}`, ageBucket: "24h",
    capturedAt: new Date(Date.parse(published) + 25 * 3600000).toISOString(), value: 10, ...over };
};

test("helpers: length buckets, lift in doublings with +1 smoothing, shrinkage toward normal", () => {
  assert.equal(lengthBucket(20000), "15-30s");
  assert.equal(lengthBucket(null), null);
  assert.equal(log2Lift(19, 9), 1);
  assert.equal(log2Lift(0, 0), 0);
  assert.equal(shrink([Math.log2(3), Math.log2(3), Math.log2(3), Math.log2(3)]), (4 * Math.log2(3)) / (4 + SHRINK_K));
  assert.equal(shrink([]), 0);
});

test("normal = median of the account's on-time snapshots; late (catch-up) snapshots never count", () => {
  const rows = Array.from({ length: 12 }, (_, i) => snap(i, { value: i < 6 ? 10 : 30 }));
  rows.push(snap(99, { value: 5000, capturedAt: NOW.toISOString() })); // caught up days later: ignored
  const [acc] = computePerformance(rows, { now: NOW });
  assert.equal(acc.normals["short@24h"].value, 20);
  assert.equal(acc.normals["short@24h"].posts, 12);
  assert.equal(acc.posts.length, 12);
  assert.equal(acc.ready, false);
});

test("under 10 posts the brand's same network and placement is the normal; with neither there is no grade", () => {
  const own = Array.from({ length: 4 }, (_, i) => snap(i));
  const other = Array.from({ length: 8 }, (_, i) => snap(i + 10, { socialAccountId: "acct2", accountName: "@other" }));
  const result = computePerformance([...own, ...other], { now: NOW });
  assert.ok(result.every((a) => a.normals["short@24h"].from === "brand"));
  assert.deepEqual(computePerformance(own, { now: NOW }), []);
});

test("groups are shrunk; a strong pillar over 10+ posts in 2+ weeks becomes a candidate finding marked early", () => {
  const rows = Array.from({ length: 30 }, (_, i) => snap(i, { value: i % 2 ? 60 : 10 }));
  const [acc] = computePerformance(rows, { now: NOW });
  const live = acc.groups.find((g) => g.dim === "pillar" && g.key === "live-shows" && g.bucket === "24h");
  assert.equal(live.posts, 15);
  assert.ok(live.weeks >= 2);
  assert.ok(live.rawLift > live.lift && live.lift > 1.25, `shrunk ${live.lift} below raw ${live.rawLift}`);
  const found = acc.candidates.find((c) => c.key === "live-shows");
  assert.equal(found.confidence, "early signal");
  assert.ok(!acc.candidates.some((c) => c.dim === "asset"));
});

test("stories and missing values are left out", () => {
  const rows = Array.from({ length: 12 }, (_, i) => snap(i));
  rows.push(snap(50, { placement: "story" }), snap(51, { value: null }));
  const [acc] = computePerformance(rows, { now: NOW });
  assert.equal(acc.posts.length, 12);
});

test("the IAM action refuses HTTP and needs a brand", async () => {
  const json = (c, b) => ({ statusCode: c, body: b });
  assert.equal((await runPerformance({ requestContext: {} }, async () => { throw new Error("no"); }, json)).statusCode, 403);
  assert.equal((await runPerformance({}, async () => { throw new Error("no"); }, json)).statusCode, 400);
});
