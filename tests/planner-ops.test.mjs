import test from "node:test";
import assert from "node:assert/strict";
import { weekToPlan, handlePlannerWeb, handlePlannerOps } from "../services/dev-api-lambda/planner-ops.mjs";
import { weekWindow } from "../services/dev-api-lambda/planner-v2-db.mjs";
import { addDaysToYmd } from "../services/dev-api-lambda/planner-v2.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
process.env.CONNECTIONS_API_SHARED_SECRET = KEY;

const brand = { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: {} } };
const nextWeek = weekWindow(brand, null).weekStart;

test("the tick plans next week first, then the week after, then rests", () => {
  assert.deepEqual(weekToPlan(brand, []), { weekStart: nextWeek, replace: false });
  assert.deepEqual(weekToPlan(brand, [nextWeek]), { weekStart: addDaysToYmd(nextWeek, 7), replace: false });
  assert.equal(weekToPlan(brand, [nextWeek, addDaysToYmd(nextWeek, 7)]), null);
});

test("a re-plan the page asked for wins, and replaces that week's unapproved posts", () => {
  const asked = { ...brand, settings: { plannerRuntime: { replanWeek: "2026-11-02" } } };
  assert.deepEqual(weekToPlan(asked, [nextWeek]), { weekStart: "2026-11-02", replace: true });
});

test("the planner page needs the owner key", async () => {
  const r = await handlePlannerWeb({ headers: {} }, { action: "view", brandSlug: "stashbox" }, () => { throw new Error("no db"); }, json);
  assert.equal(r.statusCode, 401);
});

test("cadence edits must be whole numbers from 0 to 200 per week", async () => {
  const event = { headers: { "x-elettro-connect-key": KEY } };
  const db = () => { throw new Error("should not reach the database"); };
  for (const postsPerWeek of [-1, 201, 2.5, "7"]) {
    const r = await handlePlannerWeb(event, { action: "set-cadence", brandSlug: "stashbox", rules: [{ id: "r1", postsPerWeek }] }, db, json);
    assert.equal(r.statusCode, 400, `postsPerWeek ${postsPerWeek}`);
  }
});

test("finish-post with a video id publishes and writes the ledger in one transaction", async () => {
  const sql = [];
  const client = {
    query: async (text) => { sql.push(text.trim().split(/\s+/).slice(0, 3).join(" ")); return { rowCount: 1, rows: [{ id: "p1" }] }; },
    end: async () => {}
  };
  const r = await handlePlannerOps({ action: "finish-post", id: "p1", externalPostId: "W9p6rHwRgHQ", externalUrl: "https://youtu.be/W9p6rHwRgHQ" },
    async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sql, ["BEGIN", "UPDATE \"ScheduledPost\" SET", "INSERT INTO \"PublicationLedger\"", "COMMIT"]);
});

test("claim-due-posts only marks missed or stuck posts for its own destination", async () => {
  const queries = [];
  const client = { query: async (text, values) => { queries.push({ text, values }); return { rowCount: 0, rows: [] }; }, end: async () => {} };
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  const updates = queries.filter((q) => /SET "status" = '(missed|failed)'/.test(q.text));
  assert.equal(updates.length, 2);
  for (const q of updates) {
    assert.match(q.text, /sa\."destination" = \$1/);
    assert.deepEqual(q.values, ["youtube"]);
  }
});

test("finish-post without a video id marks the post failed and keeps the error", async () => {
  let params;
  const client = { query: async (_text, values) => { params = values; return { rowCount: 1, rows: [] }; }, end: async () => {} };
  const r = await handlePlannerOps({ action: "finish-post", id: "p1", error: "quota exceeded" }, async () => client, json);
  assert.equal(r.body.status, "failed");
  assert.match(params[1], /quota exceeded/);
});
