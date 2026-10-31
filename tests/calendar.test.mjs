import test from "node:test";
import assert from "node:assert/strict";
import { handlePlannerReview } from "../services/dev-api-lambda/planner-review.mjs";
import { calendarGrid, rankReplacements } from "../services/dev-api-lambda/calendar.mjs";
import { resolvePlannerSettings } from "../services/dev-api-lambda/planner-v2.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const event = { headers: { "x-elettro-connect-key": KEY } };
const POST_ID = "0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f";
const OLD = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";
const settings = { planner: { sectors: [{ slug: "live-shows", share: 1, match: { tagsAny: ["live"] } }], pool: { kinds: ["video"] } } };
const brandRow = { id: "brand-1", slug: "stashbox", timezone: "America/New_York", settings };

function fakeClient(handlers = []) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes('FROM "Brand"')) return { rows: [brandRow] };
      for (const [match, rows] of handlers) if (sql.includes(match)) return typeof rows === "function" ? rows(params) : rows;
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
}
const call = (body, client, deps) => handlePlannerReview(event, { brand: "stashbox", ...body }, async () => client, json, deps);

test("the calendar grid is six weeks from the Monday on or before the 1st", () => {
  const g = calendarGrid("2026-11", "America/New_York"); // Nov 1 2026 is a Sunday
  assert.equal(g.start, "2026-10-26");
  assert.equal(g.end, "2026-12-07");
  assert.equal(g.from.toISOString(), "2026-10-26T04:00:00.000Z");
  const june = calendarGrid("2026-06", "America/New_York"); // a Monday
  assert.equal(june.start, "2026-06-01");
});

test("calendar shows published posts plus approved/paused ones, and marks what can still change", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const now = new Date("2026-11-10T15:00:00Z");
  const asset = { assetId: OLD, filename: "a.mp4", kind: "video", sourcePath: "/a.mp4", assetTitle: null, durationMs: 1000 };
  const client = fakeClient([
    ['FROM "ScheduledPost" sp', { rows: [
      { id: "p1", status: "approved", scheduledFor: "2026-11-12T17:00:00Z", destination: "instagram", accountName: "@s", placement: "reel", scoreBreakdown: {}, ...asset },
      { id: "p2", status: "paused", scheduledFor: "2026-11-09T17:00:00Z", destination: "facebook", accountName: "S", placement: "reel", scoreBreakdown: {}, ...asset },
      { id: "p3", status: "approved", scheduledFor: "2026-11-10T15:05:00Z", destination: "threads", accountName: "s", placement: "post", scoreBreakdown: { slideIds: [A, B] }, ...asset }
    ] }],
    ['FROM "PublicationLedger" pl', { rows: [
      { id: "l1", scheduledPostId: "p0", destination: "youtube", placement: "short", publishedAt: "2026-11-03T16:00:00Z", externalUrl: "https://youtu.be/x", accountName: "S", generatedCaption: "hi", generatedHashtags: ["#a"], scoreBreakdown: {}, ...asset }
    ] }]
  ]);
  const r = await call({ action: "calendar", month: "2026-11" }, client, { now });
  assert.equal(r.statusCode, 200);
  const statuses = client.seen.find((q) => q.sql.includes('FROM "ScheduledPost" sp')).params.at(-1);
  assert.deepEqual(statuses, ["approved", "paused", "queued", "publishing", "processing"]);
  const byId = Object.fromEntries(r.body.posts.map((p) => [p.id, p]));
  assert.equal(r.body.posts[0].id, "pub:l1", "sorted by time");
  assert.equal(byId["pub:l1"].externalUrl, "https://youtu.be/x");
  assert.equal(byId["pub:l1"].editable, false);
  assert.equal(byId.p1.editable, true);
  assert.equal(byId.p2.passedOver, true, "a paused post whose time came is passed over");
  assert.equal(byId.p2.editable, false);
  assert.equal(byId.p3.editable, false, "due within the 15-minute publish tick: locked");
  assert.equal(byId.p3.carousel, true);
});

test("Pause and Remove are statuses the review actions accept; reset clears them too", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  for (const status of ["paused", "removed", "approved"]) {
    const client = fakeClient([['UPDATE "ScheduledPost"', { rows: [{ id: POST_ID }], rowCount: 1 }]]);
    const r = await call({ action: "set-status", ids: [POST_ID], status }, client);
    assert.equal(r.statusCode, 200, status);
    assert.deepEqual(client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"')).params.at(-1), ["planned", "approved", "skipped", "paused", "removed"]);
  }
  const client = fakeClient();
  await call({ action: "reset-week", from: "2026-11-09", to: "2026-11-15" }, client, { now: new Date("2026-11-01T12:00:00Z") });
  const del = client.seen.find((q) => q.sql.includes("DELETE"));
  assert.ok(del.params[1].includes("paused") && del.params[1].includes("removed"));
});

test("replacements: planner runners-up first, never the current or an earlier clip, cooldowns respected", () => {
  const s = resolvePlannerSettings(settings);
  const at = new Date("2026-11-20T17:00:00Z");
  const v = (id, tags = ["live"], extra = {}) => ({ id, kind: "video", tags, ...extra });
  const assets = [v(OLD), v(A), v(B), v(C, ["other"]), v("img", ["live"], { kind: "image" })];
  const ranked = rankReplacements({ assets, account: { destination: "instagram", placement: "reel" }, settings: s, ymd: "2026-11-20",
    sector: "live-shows", exclude: new Set([OLD]), lastUse: new Map(), candidateIds: [B], at });
  assert.deepEqual(ranked.map((a) => a.id), [B, A, C], "runner-up B, then same sector A, then the rest; the image is out of the pool");
  const cooled = rankReplacements({ assets, account: { destination: "instagram", placement: "reel" }, settings: s, ymd: "2026-11-20",
    sector: "live-shows", exclude: new Set([OLD, B]), lastUse: new Map([[A, at.getTime() - 5 * 86400000]]), candidateIds: [], at });
  assert.deepEqual(cooled.map((a) => a.id), [C], "A was used 5 days ago (30-day cooldown), B was swapped out before");
});

const slotRow = (extra = {}) => ({ id: POST_ID, assetId: OLD, placement: "reel", scheduledFor: "2026-11-20T17:00:00Z", status: "approved",
  scoreBreakdown: { sector: "live-shows", candidateIds: [B], swapHistory: [A] }, socialAccountId: "acc-1", destination: "instagram", timezone: null, ...extra });

test("replan-slot gives the slot a new clip and new copy, keeps the status, and records the swap", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([
    ['sa."destination", sa."timezone"', { rows: [slotRow()] }],
    ['FROM "Asset"', { rows: [{ id: OLD, kind: "video", tags: ["live"] }, { id: A, kind: "video", tags: ["live"] }, { id: B, kind: "video", tags: ["live"], filename: "b.mp4" }] }],
    ['UPDATE "ScheduledPost"', { rows: [{ id: POST_ID }], rowCount: 1 }]
  ]);
  const r = await call({ action: "replan-slot", id: POST_ID }, client, { now: new Date("2026-11-10T15:00:00Z"), copyModelId: null });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.assetId, B, "A was swapped out earlier, so B");
  assert.ok(r.body.caption, "fresh copy written");
  const update = client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"'));
  assert.match(update.sql, /"status" IN \('approved','paused'\)/);
  assert.ok(!/SET[^]*"status" =/.test(update.sql.split("WHERE")[0]), "status is not changed");
  const merged = JSON.parse(update.params[7]);
  assert.deepEqual(merged.swapHistory, [A, OLD]);
  assert.equal(merged.captionEditedAfterSwap, true);
});

test("replan-slot refuses locked, carousel and not-approved posts", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const now = new Date("2026-11-20T16:50:00Z");
  const locked = await call({ action: "replan-slot", id: POST_ID }, fakeClient([['sa."destination", sa."timezone"', { rows: [slotRow()] }]]), { now });
  assert.equal(locked.statusCode, 409);
  const later = new Date("2026-11-10T15:00:00Z");
  const carousel = await call({ action: "replan-slot", id: POST_ID }, fakeClient([['sa."destination", sa."timezone"', { rows: [slotRow({ scoreBreakdown: { slideIds: [A, B] } })] }]]), { now: later });
  assert.equal(carousel.statusCode, 409);
  const planned = await call({ action: "replan-slot", id: POST_ID }, fakeClient([['sa."destination", sa."timezone"', { rows: [slotRow({ status: "planned" })] }]]), { now: later });
  assert.equal(planned.statusCode, 404);
});
