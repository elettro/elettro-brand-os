import test from "node:test";
import assert from "node:assert/strict";
import { weekKey, boostPoints, winnerCandidates, withBoost, withoutBoost, refreshChanges, decideChange, MAX_BOOST } from "../services/dev-api-lambda/planner-changes.mjs";
import { boostFor, normalizeWeights, resolvePlannerSettings, MAX_PERFORMANCE_POINTS } from "../services/dev-api-lambda/planner-v2.mjs";
import { whyOf } from "../services/dev-api-lambda/post-why.mjs";

test("week keys are Mondays; points are 10 per doubling, capped, cross-post gets 80%", () => {
  assert.equal(weekKey(new Date("2026-11-08T12:00:00Z")), "2026-11-02");
  assert.equal(weekKey(new Date("2026-11-09T00:30:00Z")), "2026-11-09");
  assert.deepEqual(boostPoints(2), { points: 10, crossPoints: 8 });
  assert.deepEqual(boostPoints(1.33), { points: 4, crossPoints: 3 });
  assert.equal(boostPoints(50).points, MAX_BOOST);
});

test("winner candidates: asset groups at 1.25x or more, one per account and asset, 7d before 24h", () => {
  const accounts = [{ socialAccountId: "A", account: "@yt", destination: "youtube", groups: [
    { dim: "asset", bucket: "24h", key: "x", label: "Clip X", posts: 1, lift: 1.6, rawLift: 9 },
    { dim: "asset", bucket: "7d", key: "x", label: "Clip X", posts: 1, lift: 1.4, rawLift: 8 },
    { dim: "asset", bucket: "7d", key: "y", label: "Clip Y", posts: 1, lift: 1.1, rawLift: 2 },
    { dim: "pillar", bucket: "7d", key: "live", label: "Live", posts: 20, lift: 2, rawLift: 3 }
  ] }];
  const out = winnerCandidates(accounts);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "winner:A:x");
  assert.equal(out[0].evidence.bucket, "7d");
  assert.deepEqual(out[0].payload, { assetId: "x", homeAccountId: "A", points: 5, crossPoints: 4 });
});

test("weights: approve adds a versioned boost, undo removes it with a new version", () => {
  const change = { id: "c1", payload: { assetId: "x", homeAccountId: "A", points: 10, crossPoints: 8 } };
  const v2 = withBoost(undefined, change);
  assert.deepEqual(v2, { version: 2, boosts: [{ changeId: "c1", assetId: "x", homeAccountId: "A", points: 10, crossPoints: 8 }] });
  assert.deepEqual(withoutBoost(v2, "c1"), { version: 3, boosts: [] });
});

test("the planner adds approved boosts as a capped performance part; nothing approved = rules only", () => {
  const settings = resolvePlannerSettings({ planner: { sectors: [] }, plannerWeights: { version: 4, boosts: [
    { changeId: "c1", assetId: "x", homeAccountId: "A", points: 15, crossPoints: 12 },
    { changeId: "c2", assetId: "x", homeAccountId: "B", points: 15, crossPoints: 12 }] } });
  assert.equal(settings.weights.version, 4);
  assert.equal(boostFor(settings.weights, "A", "x"), MAX_PERFORMANCE_POINTS);
  assert.equal(boostFor(settings.weights, "C", "x"), MAX_PERFORMANCE_POINTS);
  assert.equal(boostFor(settings.weights, "A", "other"), 0);
  assert.deepEqual(normalizeWeights(null), { version: 1, boosts: [] });
  assert.equal(resolvePlannerSettings({}).weights.version, 1);
  const why = whyOf({ breakdown: { performance: 10, freshness: 40 }, weightsVersion: "v4" });
  assert.deepEqual(why.tags, ["boosted"]);
  assert.match(why.summary, /boost you approved/);
});

// A tiny in-memory PlannerChange table for the flow tests.
function fakeDb(rows = [], brandSettings = {}) {
  const db = { rows, settings: brandSettings, snapshots: [] };
  db.client = { query: async (sql, params = []) => {
    const q = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q)) return { rows: [] };
    if (q.includes('FROM "PostMetric" pm')) return { rows: db.snapshots };
    if (q.startsWith('SELECT * FROM "PlannerChange" WHERE "brandId" = $1') && !q.includes("FOR UPDATE")) return { rows: db.rows };
    if (q.startsWith('INSERT INTO "PlannerChange"')) {
      db.rows.push({ id: "c" + (db.rows.length + 1), key: params[1], status: "watching", weekKey: params[7], evidence: JSON.parse(params[6]), payload: JSON.parse(params[5]), skips: 0 });
      return { rowCount: 1 };
    }
    if (q.includes("SET \"status\" = 'proposed'")) {
      const r = db.rows.find((x) => x.id === params[0]);
      Object.assign(r, { status: "proposed", weekKey: params[5], evidence: JSON.parse(params[4]) });
      return { rowCount: 1 };
    }
    if (q.includes("FOR UPDATE") && q.includes("PlannerChange")) return { rows: db.rows.filter((r) => r.id === params[0]) };
    if (q.startsWith('SELECT "settings" FROM "Brand"')) return { rows: [{ settings: db.settings }] };
    if (q.startsWith('UPDATE "Brand" SET "settings"')) { db.settings = { ...db.settings, plannerWeights: JSON.parse(params[1]) }; return { rowCount: 1 }; }
    if (q.startsWith('UPDATE "PlannerChange" SET "status" = $2')) {
      const r = db.rows.find((x) => x.id === params[0]);
      Object.assign(r, { status: params[1], skips: params[2], mutedUntil: params[3], weightsVersion: params[4] ?? r.weightsVersion });
      return { rowCount: 1 };
    }
    return { rows: [] };
  } };
  return db;
}

test("weekly check: a new winner is watched first and proposed only when it holds up a later week", async () => {
  const db = fakeDb();
  const snap = (i, value) => ({ ledgerId: "l" + i, socialAccountId: "A", accountName: "@yt", destination: "youtube", placement: "short",
    publishedAt: "2026-11-01T15:00:00Z", sector: "live", durationMs: 20000, assetId: i === 0 ? "star" : "a" + i, title: i === 0 ? "Star clip" : "Clip " + i,
    ageBucket: "24h", capturedAt: "2026-11-02T16:00:00Z", views: value, likes: 0 });
  db.snapshots = [snap(0, 900), ...Array.from({ length: 11 }, (_, i) => snap(i + 1, 20))];
  const brand = { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: {} };
  const first = await refreshChanges(db.client, brand, new Date("2026-11-04T12:00:00Z"));
  assert.deepEqual([first.watching, first.proposed], [1, 0]);
  const again = await refreshChanges(db.client, brand, new Date("2026-11-05T12:00:00Z"));
  assert.deepEqual([again.watching, again.proposed], [0, 0], "same week: no promotion");
  const next = await refreshChanges(db.client, brand, new Date("2026-11-11T12:00:00Z"));
  assert.equal(next.proposed, 1);
  assert.equal(db.rows[0].status, "proposed");
});

test("approve writes weights v2, undo writes v3 without it; three skips mute for 30 days; wrong states are refused", async () => {
  const db = fakeDb([{ id: "c1", key: "winner:A:x", status: "proposed", skips: 0, payload: { assetId: "x", homeAccountId: "A", points: 10, crossPoints: 8 } }]);
  const brand = { id: "b1", slug: "stashbox" };
  const ok = await decideChange(db.client, brand, { id: "c1", decision: "approve", by: "owner" });
  assert.deepEqual([ok.code, ok.body.status, ok.body.weightsVersion], [200, "approved", 2]);
  assert.equal(db.settings.plannerWeights.boosts.length, 1);
  const undo = await decideChange(db.client, brand, { id: "c1", decision: "undo" });
  assert.deepEqual([undo.body.status, undo.body.weightsVersion, db.settings.plannerWeights.boosts.length], ["undone", 3, 0]);
  assert.equal((await decideChange(db.client, brand, { id: "c1", decision: "skip" })).code, 409);
  assert.equal((await decideChange(db.client, brand, { id: "c1", decision: "maybe" })).code, 400);
  db.rows.push({ id: "c2", key: "winner:A:y", status: "proposed", skips: 2, payload: {} });
  const skipped = await decideChange(db.client, brand, { id: "c2", decision: "skip" }, new Date("2026-11-08T00:00:00Z"));
  assert.equal(skipped.body.status, "skipped");
  assert.equal(db.rows[1].mutedUntil, "2026-12-08T00:00:00.000Z");
});
