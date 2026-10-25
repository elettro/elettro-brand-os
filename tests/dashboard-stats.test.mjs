import test from "node:test";
import assert from "node:assert/strict";
import { periodStarts, poolCounts, combine, dashboardStats } from "../services/dev-api-lambda/dashboard-stats.mjs";
import { handlePlannerWeb } from "../services/dev-api-lambda/planner-ops.mjs";
import { resolvePlannerSettings } from "../services/dev-api-lambda/planner-v2.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const NY = "America/New_York";

test("today, week and month start at local midnight, weeks start on Monday", () => {
  // Saturday 2026-10-24 15:00 in New York (EDT, UTC-4)
  const s = periodStarts(NY, new Date("2026-10-24T19:00:00Z"));
  assert.equal(s.today.toISOString(), "2026-10-24T04:00:00.000Z");
  assert.equal(s.week.toISOString(), "2026-10-19T04:00:00.000Z");
  assert.equal(s.month.toISOString(), "2026-10-01T04:00:00.000Z");
});

test("on a Monday the week starts today", () => {
  const s = periodStarts(NY, new Date("2026-10-26T15:00:00Z"));
  assert.equal(s.week.toISOString(), s.today.toISOString());
});

test("possible assets follow each format's rules", () => {
  const settings = resolvePlannerSettings({});
  const assets = [
    { id: "v", kind: "video", aspectRatioLabel: "9x16", durationMs: 20000, tags: [] },
    { id: "i", kind: "image", aspectRatioLabel: "2x3", tags: [] },
    { id: "x", kind: "video", aspectRatioLabel: "9x16", durationMs: 20000, tags: [], excludedDestinations: ["pinterest"] }
  ];
  const { byFormat, anyByNetwork } = poolCounts(assets, settings, "2026-10-24");
  assert.equal(byFormat["pinterest:pin"], 1);
  assert.equal(byFormat["pinterest:video"], 1);
  assert.equal(anyByNetwork.pinterest, 2);
  assert.equal(anyByNetwork.threads, 3);
});

test("brands add up per network", () => {
  const row = (n) => ({ possible: n, scheduled: n, awaiting: 0, failed: 1, today: n, week: n, month: n, total: n });
  const brand = (n) => ({ rows: { "threads:post": row(n) }, anyByNetwork: { threads: n }, connected: new Set(["threads"]) });
  const threads = combine([brand(2), brand(3)]).find((n) => n.destination === "threads");
  assert.equal(threads.connectedBrands, 2);
  assert.equal(threads.formats[0].total, 5);
  assert.equal(threads.totals.possible, 5);
  assert.equal(threads.totals.failed, 2);
});

test("the stats action needs the planner key and rejects an unknown brand", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = "k".repeat(40);
  assert.equal((await handlePlannerWeb({ headers: {} }, { action: "stats" }, null, json)).statusCode, 401);
  const db = async () => ({ async query() { return { rows: [] }; }, async end() {} });
  const r = await dashboardStats({ brandSlug: "nope" }, db, json);
  assert.equal(r.statusCode, 404);
});

test("the stats action returns every network for one brand", async () => {
  const db = async () => ({
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", name: "Stashbox", timezone: NY, settings: {} }] };
      if (sql.includes('FROM "PublicationLedger"')) return { rows: [{ destination: "threads", placement: "post", today: 1, week: 4, month: 9, total: 20 }] };
      if (sql.includes('FROM "ScheduledPost"')) return { rows: [{ destination: "threads", placement: "post", scheduled: 6, awaiting: 2, failed: 1 }] };
      if (sql.includes('FROM "SocialAccount"')) return { rows: [{ destination: "threads" }] };
      return { rows: [{ id: "a", kind: "video", aspectRatioLabel: "9x16", durationMs: 20000, tags: [] }] };
    },
    async end() {}
  });
  const r = await dashboardStats({ brandSlug: "stashbox" }, db, json, new Date("2026-10-24T19:00:00Z"));
  assert.equal(r.statusCode, 200);
  const t = r.body.networks.find((n) => n.destination === "threads");
  assert.deepEqual(t.totals, { possible: 1, scheduled: 6, awaiting: 2, failed: 1, today: 1, week: 4, month: 9, total: 20 });
  assert.equal(t.connectedBrands, 1);
});
