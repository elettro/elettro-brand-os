import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runPlanWeeks, approvePlannerWeek } from "../services/dev-api-lambda/planner-v2-db.mjs";

const seed = JSON.parse(readFileSync(new URL("../intelligence/brands/stashbox/planner.json", import.meta.url), "utf8"));
const settings = { ...seed.settings, sources: {}, curator: { enabled: false }, copy: { enabled: false } };
const accounts = [{ socialAccountId: "a-yt", destination: "youtube", accountName: "@Stashboxband", publishingMode: "approval", timezone: "America/New_York",
  cadenceRuleId: "c1", placement: "short", postsPerWeek: 3, preferredDays: [], preferredStartTime: "09:00", preferredEndTime: "19:00" }];
// Two shows, enough clips for a month at 3/week, none ever repeated within 30 days.
const assets = Array.from({ length: 16 }, (_, i) => ({
  id: `as-${i}`, filename: `260930-stashbox-does-dylan-song-${i}-9x16-4K-01.mp4`, kind: "video", aspectRatioLabel: "9x16", durationMs: 40000,
  tags: ["stashbox-does-dylan", "studio-session", `song:song-${i}`, "ready-to-publish"], contentGroup: "260930", priority: 0,
  eligibilityType: "evergreen", createdAt: "2026-09-30T00:00:00Z"
}));

function fakeDb(log) {
  return async () => ({
    async query(sql, params) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: settings } }] };
      if (sql.includes('FROM "CadenceRule"')) return { rows: accounts };
      if (sql.includes('FROM "Asset"')) return { rows: assets };
      if (sql.startsWith("UPDATE")) return { rowCount: 12, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  });
}
const json = (status, body) => ({ status, body });

test("plan-month previews 4 weeks in order and never reuses a clip across them", async () => {
  const log = [];
  const r = await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-19", weeks: 4, copyAi: false }, fakeDb(log), json,
    { modelId: null, now: new Date("2026-10-01T12:00:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.weeks, 4);
  assert.deepEqual(r.body.perWeek.map((w) => w.weekStart), ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
  const picks = r.body.perWeek.flatMap((w) => w.slots.filter((s) => s.status === "planned").map((s) => s.assetId));
  assert.equal(picks.length, 12);
  assert.equal(new Set(picks).size, 12, "the 30-day clip cooldown holds across the month");
  assert.ok(!log.some((q) => q.startsWith("INSERT")), "preview writes nothing");
});

test("a week under way plans only its remaining slots and replaces only future unapproved posts", async () => {
  const log = [];
  const sqls = [];
  const db = fakeDb(log);
  const spy = async () => { const c = await db(); return { ...c, query: (sql, params) => { sqls.push({ sql, params }); return c.query(sql, params); } }; };
  // Wednesday 12:00 ET of the week of Oct 19.
  const now = new Date("2026-10-21T16:00:00Z");
  const r = await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-19", weeks: 1, mode: "apply", replacePlanned: true, copyAi: false }, spy, json, { modelId: null, now });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const slots = r.body.perWeek[0].slots;
  assert.ok(slots.some((s) => s.status === "past"), "earlier slots are marked past");
  for (const s of slots.filter((x) => x.status === "planned")) assert.ok(new Date(s.scheduledFor) > now, `${s.scheduledFor} is in the future`);
  const del = sqls.find((q) => q.sql.trim().startsWith('DELETE FROM "ScheduledPost"'));
  assert.ok(new Date(del.params[1]) > now, "replacing starts after now, not at Monday");
});

test("approve-month approves the whole 4-week window in one update", async () => {
  const log = [];
  const r = await approvePlannerWeek({ brandSlug: "stashbox", weekStart: "2026-10-19", weeks: 4 }, fakeDb(log), json);
  assert.equal(r.body.weeks, 4);
  assert.equal(log.filter((q) => q.startsWith("UPDATE")).length, 1);
});
