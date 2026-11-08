import test from "node:test";
import assert from "node:assert/strict";
import { applyTimeTests, buildSlots } from "../services/dev-api-lambda/planner-v2.mjs";
import { cleanTimeTests, runSetTimeTests, DEFAULT_TIME_TESTS } from "../services/dev-api-lambda/time-tests.mjs";
import { whyOf } from "../services/dev-api-lambda/post-why.mjs";

const TZ = "America/New_York";
const NOW = new Date("2026-11-01T12:00:00Z");
const account = (destination = "youtube") => ({ socialAccountId: "acct-1", destination, placement: "short", accountName: "@stashboxband", postsPerWeek: 20 });
const localHour = (iso) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(iso))) % 24;

test("20% of slots move into the test bands, alternating, on East Coast time; the rest stay 9 am - 9 pm", () => {
  const slots = buildSlots(account(), "2026-11-09", TZ);
  assert.equal(slots.length, 20);
  const moved = applyTimeTests(slots, account(), DEFAULT_TIME_TESTS, TZ, NOW);
  assert.equal(moved, 4);
  const tests = slots.filter((s) => s.timeTest);
  assert.deepEqual(tests.map((s) => s.timeTest.band), ["06:00-09:00", "21:00-23:59", "06:00-09:00", "21:00-23:59"]);
  for (const s of tests) {
    const h = localHour(s.scheduledFor);
    assert.ok((h >= 6 && h < 9) || h >= 21, `test slot at hour ${h}`);
    assert.ok(![0, 15, 30, 45].includes(Number(s.localTime.slice(3))), s.localTime);
  }
  for (const s of slots.filter((x) => !x.timeTest)) { const h = localHour(s.scheduledFor); assert.ok(h >= 9 && h < 21); }
});

test("exploration slots are never moved, other networks and disabled tests do nothing, past times stay put", () => {
  const slots = buildSlots(account(), "2026-11-09", TZ);
  slots.forEach((s) => { s.exploration = true; });
  assert.equal(applyTimeTests(slots, account(), DEFAULT_TIME_TESTS, TZ, NOW), 0);
  assert.equal(applyTimeTests(buildSlots(account("gmb"), "2026-11-09", TZ), account("gmb"), DEFAULT_TIME_TESTS, TZ, NOW), 0);
  assert.equal(applyTimeTests(buildSlots(account(), "2026-11-09", TZ), account(), { ...DEFAULT_TIME_TESTS, enabled: false }, TZ, NOW), 0);
  assert.equal(applyTimeTests(buildSlots(account(), "2026-11-09", TZ), account(), DEFAULT_TIME_TESTS, TZ, new Date("2026-12-31T00:00:00Z")), 0);
});

test("the switch: sensible defaults, refuses GMB/LinkedIn and silly shares, IAM only, dry run unless apply", async () => {
  assert.deepEqual(cleanTimeTests({}), DEFAULT_TIME_TESTS);
  assert.throws(() => cleanTimeTests({ destinations: ["gmb"] }), /never gmb/);
  assert.throws(() => cleanTimeTests({ share: 0.9 }), /share/);
  assert.throws(() => cleanTimeTests({ bands: [{ from: "21:00", to: "06:00" }] }), /bands/);
  const json = (c, b) => ({ statusCode: c, body: b });
  assert.equal((await runSetTimeTests({ requestContext: {} }, async () => { throw new Error("no"); }, json)).statusCode, 403);
  const writes = [];
  const connect = async () => ({ query: async (sql, params) => { if (/^UPDATE/.test(sql)) writes.push(params); return { rows: [{ id: "b1", timezone: TZ, settings: { planner: { sectors: [] } } }] }; }, end: async () => {} });
  const dry = await runSetTimeTests({ brandSlug: "stashbox" }, connect, json);
  assert.deepEqual([dry.body.mode, dry.body.timezone, writes.length], ["dry-run", TZ, 0]);
  const applied = await runSetTimeTests({ brandSlug: "stashbox", mode: "apply" }, connect, json);
  assert.equal(applied.body.mode, "apply");
  assert.equal(JSON.parse(writes[0][1]).share, 0.2);
});

test("Why this post? tags a moved slot as a time test", () => {
  const why = whyOf({ breakdown: { freshness: 40 }, timeTest: { band: "21:00-23:59", movedFrom: "14:37" } });
  assert.ok(why.tags.includes("time-test"));
  assert.equal(why.timeTest.movedFrom, "14:37");
});
