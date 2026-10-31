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
  // Slots before `now` are not planned at all (planWeek skips them); only the rest of the week is.
  assert.ok(slots.length > 0 && slots.every((s) => new Date(s.scheduledFor) > now), "only the rest of the week is planned");
  for (const s of slots.filter((x) => x.status === "planned")) assert.ok(new Date(s.scheduledFor) > now, `${s.scheduledFor} is in the future`);
  const del = sqls.find((q) => q.sql.trim().startsWith('DELETE FROM "ScheduledPost"'));
  assert.ok(new Date(del.params[1]) > now, "replacing starts after now, not at Monday");
});

test("posts added to a week the owner approved arrive approved; other weeks stay to review", async () => {
  for (const [approvedWeeks, expected] of [[["2026-10-26"], "approved"], [[], "planned"]]) {
    const inserts = [];
    const db = async () => ({
      async query(sql, params) {
        if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: settings, approvedWeeks } }] };
        if (sql.includes('FROM "CadenceRule"')) return { rows: accounts };
        if (sql.includes('FROM "Asset"')) return { rows: assets };
        if (sql.trim().startsWith('INSERT INTO "ScheduledPost"')) inserts.push(params);
        return { rows: [], rowCount: 0 };
      },
      async end() {}
    });
    const r = await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-26", weeks: 1, mode: "apply", copyAi: false }, db, json,
      { modelId: null, now: new Date("2026-10-01T12:00:00Z") });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.ok(inserts.length > 0);
    const ready = inserts.filter((p) => p[9]);
    assert.ok(ready.length > 0, "some posts have captions");
    for (const p of ready) assert.equal(p[11], expected);
    for (const p of inserts.filter((x) => !x[9])) assert.equal(p[11], "planned", "no caption → stays to review");
  }
});

test("approve-month approves the whole 4-week window in one update", async () => {
  const log = [];
  const r = await approvePlannerWeek({ brandSlug: "stashbox", weekStart: "2026-10-19", weeks: 4 }, fakeDb(log), json);
  assert.equal(r.body.weeks, 4);
  assert.equal(log.filter((q) => q.startsWith("UPDATE")).length, 1);
});

test("approved posts count toward their day's posts-per-day, so a replan never stacks new posts on them", async () => {
  const daily = [{ ...accounts[0], postsPerWeek: 7 }];
  // Approved at 22:00 Tuesday, outside the 09:00-19:00 window, so no slot time matches it.
  const approved = [{ socialAccountId: "a-yt", placement: "short", scheduledFor: new Date("2026-10-28T02:00:00Z") }];
  const db = async () => ({
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: settings } }] };
      if (sql.includes('FROM "CadenceRule"')) return { rows: daily };
      if (sql.includes('FROM "Asset"')) return { rows: assets };
      if (sql.includes('SELECT "socialAccountId","placement","scheduledFor" FROM "ScheduledPost"')) return { rows: approved };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  });
  const r = await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-26", weeks: 1, mode: "preview", copyAi: false }, db, json,
    { modelId: null, now: new Date("2026-10-21T16:00:00Z") });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const slots = r.body.perWeek[0].slots;
  assert.deepEqual(slots.filter((s) => s.ymd === "2026-10-27").map((s) => s.status), ["covered"]);
  assert.equal(slots.filter((s) => s.status === "planned").length, 6);
});

test("the planner only plans connected accounts, the same ones Review shows (an unconnected seed row stays out)", async () => {
  const sqls = [];
  const db = fakeDb([]);
  const spy = async () => { const c = await db(); return { ...c, query: (sql, params) => { sqls.push(sql); return c.query(sql, params); } }; };
  await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-19", weeks: 1, copyAi: false }, spy, json, { modelId: null, now: new Date("2026-10-01T12:00:00Z") });
  const q = sqls.find((s) => s.includes('FROM "CadenceRule"'));
  assert.ok(q, "the cadence query ran");
  assert.match(q, /sa\."externalAccountId" IS NOT NULL/);
});

test("a replan also clears unapproved posts of a network now at 0, but never hand-written ones", async () => {
  const sqls = [];
  const db = fakeDb([]);
  const spy = async () => { const c = await db(); return { ...c, query: (sql, params) => { sqls.push({ sql, params }); return c.query(sql, params); } }; };
  await runPlanWeeks({ brandSlug: "stashbox", weekStart: "2026-10-26", weeks: 1, mode: "apply", replacePlanned: true, copyAi: false }, spy, json, { modelId: null, now: new Date("2026-10-27T16:00:00Z") });
  const del = sqls.find((q) => q.sql.trim().startsWith('DELETE FROM "ScheduledPost"'));
  assert.ok(del, "the replan deletes the unapproved posts");
  assert.doesNotMatch(del.sql, /ANY\(\$4::uuid\[\]\)/, "no longer limited to accounts that still have an active rule");
  assert.ok(del.params[4].includes("tiktok") && !del.params[4].includes("gmb"), "every plannable network, not gmb/x");
  assert.ok(del.params[5].includes("linkedin:text") && del.params[5].includes("gmb:update"), "hand-written formats are protected");
});
