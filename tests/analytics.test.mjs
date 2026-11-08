import test from "node:test";
import assert from "node:assert/strict";
import { isOnTime, median, pillarLabel, shapePost, summarize, brandAnalytics, MAIN_METRIC, GRADE_AT } from "../services/dev-api-lambda/analytics.mjs";
import { handlePlannerReview } from "../services/dev-api-lambda/planner-review.mjs";

const PUB = "2026-11-01T15:00:00Z";
const row = (over = {}) => ({
  id: "l1", destination: "youtube", placement: "short", publishedAt: PUB, externalUrl: "https://youtu.be/x", accountName: "@stashboxband",
  title: "Clip", sector: "live-shows", breakdown: { balance: 12, freshness: 3.5 }, score: "15.5", exploration: false,
  ageBucket: "7d", capturedAt: "2026-11-08T16:00:00Z", views: "100", likes: "4", comments: "0", shares: null, reach: null, saves: null,
  linkClicks: null, watchTimeSeconds: "600", avgViewDurationSeconds: "14", ...over
});

test("on time means within 1.5x the bucket's age plus 2 hours; the first catch-up runs are late", () => {
  assert.equal(isOnTime("7d", PUB, "2026-11-08T16:00:00Z"), true);
  assert.equal(isOnTime("1h", PUB, "2026-11-01T17:30:00Z"), true);
  assert.equal(isOnTime("1h", PUB, "2026-11-09T15:00:00Z"), false);
  assert.equal(isOnTime("7d", "2026-10-29T14:13:00Z", "2026-11-07T19:58:00Z"), true);
  assert.equal(isOnTime("24h", "2026-10-29T14:13:00Z", "2026-11-07T19:58:00Z"), false);
  assert.equal(isOnTime("bogus", PUB, PUB), false);
});

test("median, pillar names", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([null]), null);
  assert.equal(pillarLabel("live-shows"), "Live shows");
  assert.equal(pillarLabel(null), "No pillar");
});

test("a post row keeps its main number per network, how late it was measured, and why the planner picked it", () => {
  const p = shapePost(row());
  assert.deepEqual([p.main, p.metrics.likes, p.metrics.shares, p.onTime, p.takenAfterHours, p.pillar], [100, 4, null, true, 169, "live-shows"]);
  assert.equal(p.why.score, 15.5);
  assert.equal(shapePost(row({ destination: "bluesky", likes: "3" })).main, 3);
  const unmeasured = shapePost(row({ ageBucket: null, capturedAt: null, views: null }));
  assert.deepEqual([unmeasured.measured, unmeasured.onTime, unmeasured.main], [false, null, null]);
  assert.equal(MAIN_METRIC.pinterest, "views");
});

test("summary: per network only, stories never measured, median typical post, rank by views or by clicks", () => {
  const posts = [
    shapePost(row({ id: "a", views: "100" })),
    shapePost(row({ id: "b", views: "10", linkClicks: "5" })),
    shapePost(row({ id: "c", views: "40", sector: "merch" })),
    shapePost(row({ id: "s", placement: "story", ageBucket: null, capturedAt: null, views: null })),
    shapePost(row({ id: "i", destination: "instagram", views: "9" }))
  ];
  const readiness = [{ destination: "youtube", accountName: "@stashboxband", onTime7d: 22 }, { destination: "instagram", accountName: "@stashboxmusic", onTime7d: 30 }];
  const s = summarize(posts, readiness);
  const yt = s.networks.find((n) => n.destination === "youtube");
  assert.deepEqual([yt.posts, yt.stories, yt.measured, yt.total, yt.typical], [4, 1, 3, 150, 40]);
  assert.deepEqual(yt.top.map((p) => p.id), ["a", "c", "b"]);
  assert.deepEqual(yt.ready, { account: "@stashboxband", onTime7d: 22, of: GRADE_AT });
  assert.equal(yt.clicks, 5);
  assert.deepEqual(yt.pillars.map((r) => [r.slug, r.posts]), [["live-shows", 2], ["merch", 1]]);
  assert.equal(yt.pillars[0].trust, false);
  assert.equal(yt.times.reduce((n, t) => n + t.posts, 0), 3);
  assert.equal(s.totals.readyAccounts, 1);
  assert.equal(s.totals.waiting, 0);
  const byClicks = summarize(posts, readiness, { sort: "clicks" });
  assert.equal(byClicks.networks.find((n) => n.destination === "youtube").top[0].id, "b");
});

test("brandAnalytics: brand-scoped queries, period clamp, summary mode leaves out the detail", async () => {
  const seen = [];
  const client = { query: async (sql, params) => { seen.push([sql, params]); return { rows: /FROM "PublicationLedger" pl/.test(sql) && !/COUNT/.test(sql) ? [row()] : [] }; } };
  const brand = { id: "b1", slug: "stashbox", timezone: "America/New_York" };
  const now = new Date("2026-11-10T12:00:00Z");
  const out = await brandAnalytics(client, brand, { days: 5 }, now);
  assert.equal(out.body.days, 28);
  assert.equal(seen[0][1][0], "b1");
  assert.equal(seen[0][1][1], new Date(now.getTime() - 28 * 864e5).toISOString());
  assert.ok(out.body.networks[0].pillars);
  const summary = await brandAnalytics(client, brand, { days: 7, summary: true }, now);
  assert.equal(summary.body.days, 7);
  assert.equal(summary.body.networks[0].pillars, undefined);
  assert.equal(summary.body.networks[0].top.length, 1);
});

test("the review route answers action analytics only with the connect key", async () => {
  const json = (c, b) => ({ statusCode: c, body: b });
  const denied = await handlePlannerReview({ headers: {} }, { brand: "stashbox", action: "analytics" }, async () => { throw new Error("no"); }, json);
  assert.equal(denied.statusCode, 401);
});

test("pillar mix: planned share from the settings next to the share actually published; an unlisted pillar still shows", async () => {
  const { pillarMix } = await import("../services/dev-api-lambda/analytics.mjs");
  const sectors = [{ slug: "live-shows", share: 0.28 }, { slug: "merch", share: 0.2 }];
  const posts = [
    shapePost(row({ id: "1", sector: "live-shows" })), shapePost(row({ id: "2", sector: "live-shows" })),
    shapePost(row({ id: "3", sector: "old-pillar" })), shapePost(row({ id: "4", sector: null })),
    shapePost(row({ id: "5", sector: "merch", placement: "story" }))
  ];
  const mix = pillarMix(sectors, posts);
  assert.equal(mix.posts, 3);
  assert.deepEqual(mix.rows.map((r) => [r.slug, r.target, r.actual, r.posts]), [["live-shows", 28, 67, 2], ["merch", 20, 0, 0], ["old-pillar", null, 33, 1]]);
  assert.deepEqual(pillarMix(sectors, []).rows[0].actual, null);
});

test("pool health: ready vs resting per pillar, running low, and seasonal windows with assets still waiting for approval", async () => {
  const { poolHealth, opensWithin } = await import("../services/dev-api-lambda/analytics.mjs");
  const settings = { cooldowns: { assetDays: 30 }, minPoolForSector: 3, sectors: [{ slug: "live-shows", match: { tagsAny: ["live"] } }, { slug: "merch", match: { tagsAny: ["merch"] } }] };
  const a = (id, tags, over = {}) => ({ id, tags, approvalStatus: "approved", eligibilityType: "always", ...over });
  const assets = [
    ...Array.from({ length: 6 }, (_, i) => a(`l${i}`, ["live"])),
    a("m1", ["merch"]), a("m2", ["merch"]),
    a("x1", ["merch"], { eligibilityType: "annual", annualFromMmdd: 1201, annualUntilMmdd: 1226 }),
    a("x2", ["merch"], { eligibilityType: "annual", annualFromMmdd: 1201, annualUntilMmdd: 1226, approvalStatus: "pending" })
  ];
  const lastUsed = new Map([["l0", "2026-11-01"], ["l1", "2026-10-01"]]);
  const pool = poolHealth(assets, lastUsed, settings, "2026-11-08");
  const live = pool.pillars.find((p) => p.slug === "live-shows");
  assert.deepEqual([live.ready, live.resting, live.nextFree, live.low], [5, 1, "2026-12-01", false]);
  const merch = pool.pillars.find((p) => p.slug === "merch");
  assert.deepEqual([merch.ready, merch.low], [2, true]);
  assert.deepEqual(pool.windows, [{ opens: "2026-12-01", approved: 1, waiting: 1 }]);
  assert.equal(opensWithin(assets[0], "2026-11-08", 45), null);
  assert.equal(opensWithin(assets[8], "2026-10-01", 45), null);
});

test("brandAnalytics detail adds last snapshot times, pillar mix and pool; summary mode keeps last snapshots only", async () => {
  const client = { query: async (sql) => {
    if (/MAX\(pm\."capturedAt"\)/.test(sql)) return { rows: [{ destination: "youtube", at: "2026-11-08T11:45:00Z" }] };
    if (/FROM "PublicationLedger" pl/.test(sql) && !/COUNT/.test(sql)) return { rows: [row()] };
    return { rows: [] };
  } };
  const brand = { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: { sectors: [{ slug: "live-shows", share: 0.5, match: { tagsAny: ["live"] } }] } } };
  const now = new Date("2026-11-08T12:00:00Z");
  const full = await brandAnalytics(client, brand, {}, now);
  assert.equal(full.body.lastSnapshots.youtube, "2026-11-08T11:45:00.000Z");
  assert.equal(full.body.networks[0].lastSnapshotAt, "2026-11-08T11:45:00.000Z");
  assert.equal(full.body.networks[0].waiting, 0);
  assert.equal(full.body.pillarMix.rows[0].target, 50);
  assert.ok(Array.isArray(full.body.pool.pillars));
  const summary = await brandAnalytics(client, brand, { summary: true }, now);
  assert.equal(summary.body.pool, undefined);
  assert.equal(summary.body.lastSnapshots.youtube, "2026-11-08T11:45:00.000Z");
});
