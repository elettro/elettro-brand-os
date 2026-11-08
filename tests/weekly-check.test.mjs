import test from "node:test";
import assert from "node:assert/strict";
import { gradeChange, weeklyChangesCheck, PLANNER_CHANGE_SQL } from "../services/dev-api-lambda/planner-changes.mjs";
import { plannerTick } from "../services/dev-api-lambda/planner-ops.mjs";

const change = (outcome = null) => ({ id: "c1", decidedAt: "2026-11-10T00:00:00Z", payload: { assetId: "x" }, outcome });
const accounts = (posts) => [{ account: "@yt", posts }];
const post = (over) => ({ assetId: "x", publishedAt: "2026-11-12T15:00:00Z", bucket: "7d", lift: 1.5, ...over });
const NOW = new Date("2026-11-22T12:00:00Z");

test("an approved boost is graded by the asset's posts since approval: helped, hurt, no clear difference, waiting", () => {
  assert.equal(gradeChange(change(), accounts([post({ lift: 1.5 }), post({ lift: 1.2 })]), NOW).label, "helped");
  assert.equal(gradeChange(change(), accounts([post({ lift: 0.5 })]), NOW).label, "hurt");
  assert.equal(gradeChange(change(), accounts([post({ lift: 1.0 })]), NOW).label, "no clear difference");
  const waiting = gradeChange(change(), accounts([post({ publishedAt: "2026-11-01T00:00:00Z" }), post({ assetId: "other" })]), NOW);
  assert.deepEqual([waiting.label, waiting.posts], ["waiting", 0]);
  const dayOnly = gradeChange(change(), accounts([post({ bucket: "24h", lift: 2 }), post({ bucket: "1h", lift: 9 })]), NOW);
  assert.deepEqual([dayOnly.bucket, dayOnly.lift], ["24h", 2]);
});

test("hurt two checks running suggests Undo; history keeps the last 6", () => {
  const once = gradeChange(change(), accounts([post({ lift: 0.5 })]), NOW);
  assert.equal(once.undoSuggested, false);
  const twice = gradeChange(change(once), accounts([post({ lift: 0.6 })]), NOW);
  assert.equal(twice.undoSuggested, true);
  const long = gradeChange(change({ history: ["helped", "helped", "helped", "helped", "helped", "helped"] }), accounts([post()]), NOW);
  assert.equal(long.history.length, 6);
  assert.ok(PLANNER_CHANGE_SQL.some((s) => /ADD COLUMN IF NOT EXISTS "outcome"/.test(s)));
});

test("the weekly check runs only from Sunday 10 pm on the brand's own clock, once per week", async () => {
  const marks = [];
  const client = { query: async (sql, params) => {
    if (/FROM "Brand" WHERE "status" = 'active'/.test(sql)) return { rows: [
      { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: {} },
      { id: "b2", slug: "solarmeister", timezone: "Europe/Berlin", settings: { changesCheckedWeek: "2026-11-23" } }] };
    if (/changesCheckedWeek/.test(sql)) { marks.push(params); return { rowCount: 1 }; }
    return { rows: [] };
  } };
  // Sunday 22:30 New York = Monday 04:30 Berlin: only Stashbox is due (SolarMeister is past Sunday and already marked).
  const ran = await weeklyChangesCheck(client, new Date("2026-11-23T03:30:00Z"));
  assert.deepEqual(ran.map((r) => r.brand), ["stashbox"]);
  assert.deepEqual(marks[0], ["b1", "2026-11-23"]);
  // Sunday 20:00 New York: too early for everyone.
  assert.deepEqual(await weeklyChangesCheck(client, new Date("2026-11-23T01:00:00Z")), []);
});

test("a failing weekly check never stops the planner tick", async () => {
  const json = (c, b) => ({ statusCode: c, body: b });
  const connect = async () => ({ query: async () => ({ rows: [] }), end: async () => {} });
  const out = await plannerTick(connect, json, { weeklyCheck: async () => { throw new Error("no table yet"); } });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.planned, null);
});
