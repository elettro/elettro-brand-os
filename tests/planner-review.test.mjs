import test from "node:test";
import assert from "node:assert/strict";
import { handlePlannerReview, reviewWindow } from "../services/dev-api-lambda/planner-review.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const event = { headers: { "x-elettro-connect-key": KEY } };
const noDatabase = async () => { throw new Error("database should not be reached"); };
const brandRow = { id: "brand-1", slug: "stashbox", timezone: "America/New_York", settings: {} };

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

test("the review window starts on this week's Monday in the brand's time zone", () => {
  // Sunday evening in New York is already Monday in UTC; the window must still start on the NY Monday before.
  const w = reviewWindow("America/New_York", null, 4, new Date("2026-10-19T03:00:00Z"));
  assert.equal(w.weekStart, "2026-10-12");
  assert.equal(w.weeks, 4);
  assert.equal(w.from.toISOString(), "2026-10-12T04:00:00.000Z");
  assert.equal(w.to.toISOString(), "2026-11-09T05:00:00.000Z");
});

test("every action needs the shared key, a brand and a known action", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await handlePlannerReview({ headers: {} }, { brand: "stashbox", action: "list" }, noDatabase, json)).statusCode, 401);
  assert.equal((await handlePlannerReview(event, { brand: "Stash Box", action: "list" }, noDatabase, json)).statusCode, 400);
  assert.equal((await handlePlannerReview(event, { brand: "stashbox", action: "publish-now" }, noDatabase, json)).statusCode, 400);
});

test("set-status only moves posts between planned, approved and skipped", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['UPDATE "ScheduledPost"', { rows: [{ id: "x" }], rowCount: 1 }]]);
  const bad = await handlePlannerReview(event, { brand: "stashbox", action: "set-status", ids: ["0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f"], status: "queued" }, async () => client, json);
  assert.equal(bad.statusCode, 400);
  const ok = await handlePlannerReview(event, { brand: "stashbox", action: "set-status", ids: ["0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f"], status: "approved" }, async () => client, json);
  assert.equal(ok.statusCode, 200);
  const update = client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"'));
  assert.deepEqual(update.params.at(-1), ["planned", "approved", "skipped"]);
});

test("plan seeds missing planner settings and starts plan-week for the networks asked for", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient();
  const invoked = [];
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26", destinations: ["instagram", "youtube"] },
    async () => client, json, {
      invoke: async (payload) => { invoked.push(payload); },
      readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } }),
      now: new Date("2026-10-20T15:00:00Z")
    });
  assert.equal(r.statusCode, 202);
  assert.ok(client.seen.some((q) => q.sql.includes("jsonb_set") && q.params[1].includes('"sectors"')));
  assert.deepEqual(invoked, [{ action: "plan-week", brandSlug: "stashbox", weekStart: "2026-10-26", mode: "apply", replacePlanned: true, destinations: ["instagram", "youtube"] }]);
});

test("by default the Review page plans and approves every network", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const invoked = [];
  await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26" }, async () => fakeClient(), json, {
    invoke: async (payload) => { invoked.push(payload); }, readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } }),
    now: new Date("2026-10-20T15:00:00Z")
  });
  assert.equal(invoked[0].destinations, null);
  const client = fakeClient([['UPDATE "ScheduledPost" sp SET "status"=\'approved\'', { rows: [{ id: "x" }], rowCount: 7 }]]);
  await handlePlannerReview(event, { brand: "stashbox", action: "approve-range", from: "2026-10-26", to: "2026-11-01" }, async () => client, json);
  const approve = client.seen.find((q) => q.sql.includes("SET \"status\"='approved'"));
  assert.equal(approve.params[3], null, "no network filter");
});

test("approving a whole week remembers it; part of a week or some networks does not", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const whole = fakeClient([['UPDATE "ScheduledPost"', { rows: [], rowCount: 3 }]]);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "approve-range", from: "2026-10-26", to: "2026-11-01" }, async () => whole, json);
  assert.equal(r.body.weekApproved, true);
  const saved = whole.seen.find((q) => q.sql.includes("'{approvedWeeks}'"));
  assert.deepEqual(JSON.parse(saved.params[1]), ["2026-10-26"]);
  for (const body of [{ from: "2026-10-26", to: "2026-10-28" }, { from: "2026-10-26", to: "2026-11-01", destinations: ["instagram"] }]) {
    const part = fakeClient([['UPDATE "ScheduledPost"', { rows: [], rowCount: 1 }]]);
    const p = await handlePlannerReview(event, { brand: "stashbox", action: "approve-range", ...body }, async () => part, json);
    assert.equal(p.body.weekApproved, false);
    assert.ok(!part.seen.some((q) => q.sql.includes("'{approvedWeeks}'")));
  }
});

test("plan accepts the week under way but not a finished one", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const deps = { invoke: async () => {}, readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } }), now: new Date("2026-10-20T15:00:00Z") };
  const underway = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-19" }, async () => fakeClient(), json, deps);
  assert.equal(underway.statusCode, 202);
  const over = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-12" }, async () => fakeClient(), json, deps);
  assert.equal(over.statusCode, 400);
});

test("the review window reaches nine weeks: this week plus two months", () => {
  assert.equal(reviewWindow("America/New_York", "2026-10-19", 9).weeks, 9);
  assert.equal(reviewWindow("America/New_York", "2026-10-19", 20).weeks, 9);
});

test("cadence needs a connected account", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "reel", postsPerWeek: 7 },
    async () => fakeClient(), json);
  assert.equal(r.statusCode, 409);
});

const POST_ID = "0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f";

test("TikTok settings need an explicit privacy choice and follow TikTok's disclosure rules", async () => {
  const { tiktokSettings } = await import("../services/dev-api-lambda/planner-review.mjs");
  assert.throws(() => tiktokSettings({}), /who can view/);
  assert.deepEqual(tiktokSettings({ privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true }),
    { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: false, yourBrand: false, brandedContent: false });
  assert.throws(() => tiktokSettings({ privacyLevel: "PUBLIC_TO_EVERYONE", disclose: true }), /pick Your brand/);
  assert.throws(() => tiktokSettings({ privacyLevel: "SELF_ONLY", disclose: true, brandedContent: true }), /can't be private/);
});

test("tiktok-approve stores the settings and approves only TikTok posts", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['UPDATE "ScheduledPost"', { rows: [{ id: POST_ID }], rowCount: 1 }]]);
  const missing = await handlePlannerReview(event, { brand: "stashbox", action: "tiktok-approve", id: POST_ID }, async () => client, json);
  assert.equal(missing.statusCode, 400);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "tiktok-approve", id: POST_ID, privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: true },
    async () => client, json);
  assert.equal(r.statusCode, 200);
  const update = client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"'));
  assert.match(update.sql, /destination" = 'tiktok'/);
  assert.equal(JSON.parse(update.params[2]).privacyLevel, "FOLLOWER_OF_CREATOR");
});

test("plain approval refuses TikTok posts that have no TikTok settings", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['UPDATE "ScheduledPost"', { rows: [], rowCount: 0 }]]);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "set-status", ids: [POST_ID], status: "approved" }, async () => client, json);
  assert.equal(r.statusCode, 409);
  assert.match(client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"')).sql, /scoreBreakdown" \? 'tiktok'/);
});

test("setting Reels per day leaves the Stories rule alone", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([
    ['FROM "SocialAccount" WHERE', { rows: [{ id: "sa-ig" }] }],
    ['FROM "CadenceRule" WHERE', { rows: [{ id: "rule-reel" }] }]
  ]);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "reel", postsPerWeek: 35 },
    async () => client, json);
  assert.equal(r.statusCode, 200);
  const updates = client.seen.filter((q) => q.sql.includes('UPDATE "CadenceRule"'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params, ["rule-reel", 35, true]);
});
