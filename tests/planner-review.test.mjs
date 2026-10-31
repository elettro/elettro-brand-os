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

test("plan seeds missing planner settings and starts plan-week only for the asked networks that are connected", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['SELECT DISTINCT "destination"', { rows: [{ destination: "instagram" }, { destination: "x" }] }]]);
  const invoked = [];
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26", destinations: ["instagram", "youtube"] },
    async () => client, json, {
      invoke: async (payload) => { invoked.push(payload); },
      readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } }),
      now: new Date("2026-10-20T15:00:00Z")
    });
  assert.equal(r.statusCode, 202);
  assert.ok(client.seen.some((q) => q.sql.includes("jsonb_set") && q.params[1].includes('"sectors"')));
  // youtube isn't connected and x isn't integrated yet, so only instagram is planned.
  assert.deepEqual(invoked, [{ action: "plan-week", brandSlug: "stashbox", weekStart: "2026-10-26", mode: "apply", replacePlanned: true, destinations: ["instagram"] }]);
});

test("by default the Review page plans every connected network and approves every network", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const invoked = [];
  const connected = fakeClient([['SELECT DISTINCT "destination"', { rows: ["instagram", "facebook", "youtube", "threads", "x"].map((destination) => ({ destination })) }]]);
  await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26" }, async () => connected, json, {
    invoke: async (payload) => { invoked.push(payload); }, readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } }),
    now: new Date("2026-10-20T15:00:00Z")
  });
  assert.deepEqual([...invoked[0].destinations].sort(), ["facebook", "instagram", "threads", "youtube"]);
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
  const connected = () => fakeClient([['SELECT DISTINCT "destination"', { rows: [{ destination: "facebook" }] }]]);
  const underway = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-19" }, async () => connected(), json, deps);
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

test("the week's TikTok card approves many TikTok posts with one set of the creator's choices", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const ids = [POST_ID, "1f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f", "2f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f"];
  const client = fakeClient([['UPDATE "ScheduledPost"', { rows: ids.map((id) => ({ id })), rowCount: 3 }]]);
  const noChoice = await handlePlannerReview(event, { brand: "stashbox", action: "tiktok-approve", ids }, async () => client, json);
  assert.equal(noChoice.statusCode, 400, "who can view must be chosen; there is no default");
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "tiktok-approve", ids, privacyLevel: "SELF_ONLY" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.approved, 3);
  const update = client.seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"'));
  assert.deepEqual(update.params[1], ids);
  assert.match(update.sql, /destination" = 'tiktok'/);
  const bad = await handlePlannerReview(event, { brand: "stashbox", action: "tiktok-approve", ids: [POST_ID, "nope"], privacyLevel: "SELF_ONLY" }, async () => client, json);
  assert.equal(bad.statusCode, 400);
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

test("list hands the page every publishing format, without planner rules, and each account's id", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['LEFT JOIN "CadenceRule"', { rows: [{ socialAccountId: "sa-yt", destination: "youtube", accountName: "@Stashboxband",
    externalAccountId: "UC1", publishingMode: "approval", placement: "short", postsPerWeek: 21, active: true }] }]]);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "list" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.formats.length, 28);
  assert.ok(r.body.formats.every((f) => !("rule" in f)));
  assert.equal(r.body.formats.find((f) => f.destination === "gmb").status, "integration");
  assert.equal(r.body.maxPostsPerWeek, 98);
  assert.equal(r.body.accounts[0].socialAccountId, "sa-yt");
  assert.ok(r.body.destinations.includes("youtube") && r.body.destinations.includes("pinterest"));
});

test("cadence refuses unknown formats and formats still waiting on an integration", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const unknown = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "hologram", postsPerWeek: 7 }, async () => fakeClient(), json);
  assert.equal(unknown.statusCode, 400);
  const x = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "x", placement: "video", postsPerWeek: 7 }, async () => fakeClient(), json);
  assert.equal(x.statusCode, 409);
  const gmb = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "gmb", placement: "update", postsPerWeek: 7 }, async () => fakeClient(), json);
  assert.equal(gmb.statusCode, 409);
});

test("a network takes at most 14 posts a day across its formats", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([
    ['FROM "SocialAccount" WHERE', { rows: [{ id: "sa-ig" }] }],
    ["AS n FROM", { rows: [{ n: 42 }] }]
  ]);
  const over = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "reel", postsPerWeek: 60 }, async () => client, json);
  assert.equal(over.statusCode, 400);
  assert.ok(!client.seen.some((q) => q.sql.includes('UPDATE "CadenceRule"') || q.sql.includes('INSERT INTO "CadenceRule"')));
  const fits = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "reel", postsPerWeek: 56 }, async () => client, json);
  assert.equal(fits.statusCode, 200);
});

test("cadence saves to the named account when a network has more than one", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const id = "0b6f1c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
  const client = fakeClient([['FROM "SocialAccount" WHERE', (params) => ({ rows: [{ id: params[2] || "sa-newest" }] })]]);
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "pinterest", placement: "pin", socialAccountId: id, postsPerWeek: 3 }, async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.socialAccountId, id);
  const insert = client.seen.find((q) => q.sql.includes('INSERT INTO "CadenceRule"'));
  assert.deepEqual(insert.params.slice(0, 3), [id, "pin", 3]);
});

test("reset-week deletes only the week's unsent posts and un-approves a whole week", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const approved = { ...brandRow, settings: { approvedWeeks: ["2026-10-26", "2026-11-09"] } };
  const client = fakeClient([['DELETE FROM "ScheduledPost"', { rows: [{ id: "a" }, { id: "b" }], rowCount: 2 }]]);
  client.query = ((q) => async (sql, params) => sql.includes('FROM "Brand"') ? { rows: [approved] } : q(sql, params))(client.query.bind(client));
  const now = new Date("2026-10-22T18:00:00Z");
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "reset-week", from: "2026-10-26", to: "2026-11-01" }, async () => client, json, { now });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.deleted, 2);
  const del = client.seen.find((q) => q.sql.includes('DELETE FROM "ScheduledPost"'));
  assert.deepEqual(del.params[1], ["planned", "approved", "skipped", "failed"]);
  assert.ok(!del.params[1].includes("published") && !del.params[1].includes("queued"));
  const settings = client.seen.find((q) => q.sql.includes("approvedWeeks"));
  assert.deepEqual(JSON.parse(settings.params[1]), ["2026-11-09"]);
  // A whole-week reset holds the week so the planner tick doesn't refill it; it also clears unapproved posts whose slot already passed.
  const held = client.seen.find((q) => q.sql.includes("heldWeeks"));
  assert.deepEqual(JSON.parse(held.params[1]), ["2026-10-26"]);
  assert.equal(new Date(del.params[5]).toISOString(), new Date(del.params[5]).toISOString());
  assert.ok(!del.sql.includes("<> 'approved'"));
});

test("reset-week keeps today's already-past posts and leaves approval alone when narrowed to some networks", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient([['DELETE FROM "ScheduledPost"', { rows: [], rowCount: 0 }]]);
  const now = new Date("2026-10-28T18:00:00Z");
  await handlePlannerReview(event, { brand: "stashbox", action: "reset-week", from: "2026-10-26", to: "2026-11-01", destinations: ["instagram"] }, async () => client, json, { now });
  const del = client.seen.find((q) => q.sql.includes('DELETE FROM "ScheduledPost"'));
  assert.equal(new Date(del.params[2]).toISOString(), now.toISOString());
  assert.deepEqual(del.params[4], ["instagram"]);
  assert.ok(!client.seen.some((q) => q.sql.includes("approvedWeeks")));
  assert.ok(!client.seen.some((q) => q.sql.includes("heldWeeks")));
  assert.equal((await handlePlannerReview(event, { brand: "stashbox", action: "reset-week", from: "x", to: "y" }, async () => client, json)).statusCode, 400);
});

test("edit saves a title of 1-100 characters and refuses one that YouTube would reject", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const id = "0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f";
  const client = fakeClient([['UPDATE "ScheduledPost" SET "generatedCaption"', { rows: [{ id }], rowCount: 1 }]]);
  const ok = await handlePlannerReview(event, { brand: "stashbox", action: "edit", id, caption: "Caption", title: "  A fine title  " }, async () => client, json);
  assert.equal(ok.statusCode, 200);
  const update = client.seen.find((q) => q.sql.includes('"generatedTitle"'));
  assert.equal(update.params[5], "A fine title");
  for (const title of ["", "x".repeat(101), "bad <b> title"]) {
    const bad = await handlePlannerReview(event, { brand: "stashbox", action: "edit", id, caption: "Caption", title }, async () => client, json);
    assert.equal(bad.statusCode, 400, `title ${JSON.stringify(title).slice(0, 20)} should be refused`);
  }
  // No title sent: the stored title is left alone.
  const keep = fakeClient([['UPDATE "ScheduledPost" SET "generatedCaption"', { rows: [{ id }], rowCount: 1 }]]);
  await handlePlannerReview(event, { brand: "stashbox", action: "edit", id, caption: "Caption" }, async () => keep, json);
  assert.equal(keep.seen.find((q) => q.sql.includes('"generatedTitle"')).params[5], null);
});

test("reschedule moves one unsent post, and only to a sensible time", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const id = "0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f";
  const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const client = fakeClient([['SET "scheduledFor"=$3', { rows: [{ id, scheduledFor: soon }], rowCount: 1 }]]);
  const ok = await handlePlannerReview(event, { brand: "stashbox", action: "reschedule", id, scheduledFor: soon }, async () => client, json);
  assert.equal(ok.statusCode, 200);
  const q = client.seen.find((x) => x.sql.includes('SET "scheduledFor"=$3'));
  assert.deepEqual(q.params[3], ["planned", "approved", "skipped"]);
  for (const scheduledFor of ["not a date", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), new Date(Date.now() + 500 * 24 * 60 * 60 * 1000).toISOString()]) {
    const bad = await handlePlannerReview(event, { brand: "stashbox", action: "reschedule", id, scheduledFor }, async () => client, json);
    assert.equal(bad.statusCode, 400);
  }
  const gone = await handlePlannerReview(event, { brand: "stashbox", action: "reschedule", id, scheduledFor: soon }, async () => fakeClient(), json);
  assert.equal(gone.statusCode, 404);
});
