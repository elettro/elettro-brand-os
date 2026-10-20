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

test("plan seeds missing planner settings and starts plan-week for instagram + facebook only", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient();
  const invoked = [];
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26", destinations: ["instagram", "youtube"] },
    async () => client, json, {
      invoke: async (payload) => { invoked.push(payload); },
      readSeed: () => JSON.stringify({ settings: { sectors: [{ id: "live" }] } })
    });
  assert.equal(r.statusCode, 202);
  assert.ok(client.seen.some((q) => q.sql.includes("jsonb_set") && q.params[1].includes('"sectors"')));
  assert.deepEqual(invoked, [{ action: "plan-week", brandSlug: "stashbox", weekStart: "2026-10-26", mode: "apply", replacePlanned: true, destinations: ["instagram"] }]);
});

test("cadence needs a connected account", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "cadence", destination: "instagram", placement: "reel", postsPerWeek: 7 },
    async () => fakeClient(), json);
  assert.equal(r.statusCode, 409);
});
