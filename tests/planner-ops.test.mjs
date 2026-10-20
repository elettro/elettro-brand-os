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
  const weekAfter = addDaysToYmd(nextWeek, 7);
  assert.deepEqual(weekToPlan(brand, { youtube: [] }), { weekStart: nextWeek, replace: false, destinations: ["youtube"] });
  assert.deepEqual(weekToPlan(brand, { youtube: [nextWeek] }), { weekStart: weekAfter, replace: false, destinations: ["youtube"] });
  assert.equal(weekToPlan(brand, { youtube: [nextWeek, weekAfter] }), null);
  assert.equal(weekToPlan(brand, {}), null);
});

test("a week planned for some networks is still planned for the others, and only for them", () => {
  // The Review page planned next week for Instagram + Facebook; YouTube and TikTok still need it.
  const planned = { instagram: [nextWeek], facebook: [nextWeek], youtube: [], tiktok: [] };
  assert.deepEqual(weekToPlan(brand, planned), { weekStart: nextWeek, replace: false, destinations: ["tiktok", "youtube"] });
});

test("the tick asks the planner for just the networks missing from the week", async () => {
  let cadenceParams;
  const db = async () => ({
    async query(sql, params) {
      if (sql.includes('SELECT DISTINCT b."slug"')) return { rows: [{ slug: "stashbox" }] };
      if (sql.includes('FROM "Brand"')) return { rows: [{ ...brand, settings: { planner: { sectors: [{ id: "live" }] } } }] };
      if (sql.includes('SELECT DISTINCT sa."destination" FROM')) return { rows: [{ destination: "instagram" }, { destination: "youtube" }] };
      if (sql.includes('AS "week"')) return { rows: [{ destination: "instagram", week: nextWeek }] };
      if (sql.includes('FROM "CadenceRule" cr JOIN')) { cadenceParams = params; return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  });
  const r = await handlePlannerOps({ action: "planner-tick" }, db, json);
  assert.deepEqual(cadenceParams?.[1], ["youtube"]);
  assert.deepEqual(r.body.destinations, ["youtube"]);
});

test("a re-plan the page asked for wins, and replaces that week's unapproved posts on every network", () => {
  const asked = { ...brand, settings: { plannerRuntime: { replanWeek: "2026-11-02" } } };
  assert.deepEqual(weekToPlan(asked, { youtube: [nextWeek] }), { weekStart: "2026-11-02", replace: true, destinations: null });
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

test("claimed posts carry the AI flag from the clip's own tags, or from the planner", async () => {
  const rows = [
    { id: "p1", brandId: "b1", assetTags: ["seedance", "AI-Generated"], plannedSynthetic: "false" },
    { id: "p2", brandId: "b1", assetTags: ["studio-session"], plannedSynthetic: "true" },
    { id: "p3", brandId: "b1", assetTags: ["studio-session"], plannedSynthetic: null }
  ];
  const client = {
    query: async (text) => {
      if (text.includes("RETURNING sp.\"id\"")) return { rowCount: 3, rows };
      if (text.includes('FROM "Brand"')) return { rows: [{ settings: { planner: { syntheticTagsAny: ["ai-generated"] } } }] };
      return { rowCount: 0, rows: [] };
    },
    end: async () => {}
  };
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  assert.deepEqual(r.body.posts.map((p) => [p.id, p.synthetic]), [["p1", true], ["p2", true], ["p3", false]]);
  assert.ok(!("assetTags" in r.body.posts[0]) && !("brandId" in r.body.posts[0]));
});

test("finish-post without a video id marks the post failed and keeps the error", async () => {
  let params;
  const client = { query: async (_text, values) => { params = values; return { rowCount: 1, rows: [] }; }, end: async () => {} };
  const r = await handlePlannerOps({ action: "finish-post", id: "p1", error: "quota exceeded" }, async () => client, json);
  assert.equal(r.body.status, "failed");
  assert.match(params[1], /quota exceeded/);
});
