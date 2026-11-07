import test from "node:test";
import assert from "node:assert/strict";
import { startPlanRun, makeReporter, planStatusOf, writeNetwork, continueChain, STALE_MS } from "../services/dev-api-lambda/plan-runs.mjs";
import { runPlanWeek } from "../services/dev-api-lambda/planner-v2-db.mjs";

const recorder = () => {
  const seen = [];
  return { seen, async query(sql, params) { seen.push({ sql, params }); return { rows: [], rowCount: 1 }; }, async end() {} };
};

test("startPlanRun queues every network, prunes old weeks, and starts only the first network with the rest as its chain", async () => {
  const client = recorder();
  const brand = { id: "b1", slug: "stashbox", settings: { planRuns: { "2026-09-07": {}, "2026-11-02": {} } } };
  const invoked = [];
  const run = await startPlanRun(client, brand, { weekStart: "2026-11-09", destinations: ["instagram", "youtube"],
    invoke: async (p) => { invoked.push(p); }, now: new Date("2026-11-07T12:00:00Z") });
  const write = client.seen[0];
  assert.match(write.sql, /'\{planRuns\}'/);
  assert.equal(write.params[1], "2026-11-09");
  const record = JSON.parse(write.params[2]);
  assert.equal(record.runId, run.runId);
  assert.deepEqual(Object.keys(record.networks), ["instagram", "youtube"]);
  assert.deepEqual(write.params[3], ["2026-09-07"], "weeks more than 3 weeks back are dropped, recent ones kept");
  assert.equal(invoked.length, 1, "one network at a time: the account allows only 10 Lambda runs at once");
  assert.deepEqual([invoked[0].destinations, invoked[0].chain, invoked[0].runId, invoked[0].mode], [["instagram"], ["youtube"], run.runId, "apply"]);
});

test("if the chain cannot start, every network is marked failed", async () => {
  const client = recorder();
  await startPlanRun(client, { id: "b1", slug: "stashbox", settings: {} }, { weekStart: "2026-11-09", destinations: ["instagram", "youtube"],
    invoke: async () => { throw new Error("throttled"); } });
  const failed = client.seen.filter((q) => q.sql.includes("ARRAY['planRuns'")).map((q) => [q.params[2], JSON.parse(q.params[3]).state]);
  assert.deepEqual(failed, [["instagram", "failed"], ["youtube", "failed"]]);
});

test("each finished network starts the next one; the last one ends the chain", async () => {
  const invoked = [];
  const invoke = async (p) => { invoked.push(p); };
  assert.equal(await continueChain({ brandSlug: "stashbox", weekStart: "2026-11-09", replacePlanned: true, runId: "r1", chain: ["tiktok", "x"] }, invoke), true);
  assert.deepEqual([invoked[0].destinations, invoked[0].chain, invoked[0].replacePlanned], [["tiktok"], ["x"], true]);
  assert.equal(await continueChain({ runId: "r1", chain: [] }, invoke), false);
  assert.equal(await continueChain({ chain: ["x"] }, invoke), false, "no run id: not part of a run");
  assert.equal(await continueChain({ runId: "r1", chain: ["x"] }, async () => { throw new Error("busy"); }), false, "never throws");
});

test("status writes only land on the run that owns the week (a newer Plan click wins)", async () => {
  const client = recorder();
  await writeNetwork(client, { brandId: "b1", weekStart: "2026-11-09", runId: "r1", destination: "tiktok" }, { state: "done" });
  assert.match(client.seen[0].sql, /#>> ARRAY\['planRuns', \$2::text, 'runId'\] = \$5/);
  assert.equal(client.seen[0].params[4], "r1");
});

test("the reporter throttles caption progress but always writes the last one, and never throws", async () => {
  const client = recorder();
  let t = 0;
  const r = makeReporter(client, { brandId: "b1", weekStart: "2026-11-09", runId: "r1", destination: "x" }, { now: () => t });
  r.step("writing");
  for (let i = 1; i <= 10; i += 1) { t += 500; r.progress(i, 10); }
  await r.flush();
  const states = client.seen.map((q) => JSON.parse(q.params[3]));
  assert.equal(states.at(-1).done, 10);
  assert.ok(states.length < 10, `throttled (${states.length} writes)`);
  const broken = makeReporter({ async query() { throw new Error("db gone"); } }, { brandId: "b1", weekStart: "w", runId: "r", destination: "x" });
  await broken.done({ posts: 1 });
  await broken.flush();
});

test("Review sees running weeks and finished counts; a run silent for too long shows its open networks as stalled", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const fresh = new Date(now.getTime() - 60000).toISOString();
  const old = new Date(now.getTime() - STALE_MS - 1000).toISOString();
  const status = planStatusOf({ planRuns: { "2026-11-09": { runId: "r1", startedAt: old, networks: {
    instagram: { state: "done", posts: 70, updatedAt: fresh },
    youtube: { state: "running", step: "writing", done: 3, total: 21, updatedAt: fresh },
    tiktok: { state: "queued", updatedAt: old } } } } }, now);
  const w = status["2026-11-09"];
  assert.equal(w.running, true);
  assert.equal(w.finished, 1);
  assert.equal(w.total, 3);
  assert.equal(w.networks.tiktok.state, "queued", "waiting its turn while the run is alive");
  const dead = planStatusOf({ planRuns: { "2026-11-09": { runId: "r1", startedAt: old, networks: {
    instagram: { state: "done", posts: 70, updatedAt: old }, youtube: { state: "running", step: "picking", updatedAt: old }, tiktok: { state: "queued", updatedAt: old } } } } }, now)["2026-11-09"];
  assert.equal(dead.running, false);
  assert.deepEqual([dead.networks.instagram.state, dead.networks.youtube.state, dead.networks.tiktok.state], ["done", "stalled", "stalled"]);
  assert.deepEqual(planStatusOf({}), {});
});

test("a one-network run that fails before planning marks that network failed", async () => {
  const seen = [];
  const db = async () => ({
    async query(sql, params) { seen.push({ sql, params }); if (sql.includes('FROM "Brand"')) return { rows: [] }; return { rows: [], rowCount: 1 }; },
    async end() {}
  });
  const json = (status, body) => ({ status, body });
  const next = [];
  const r = await runPlanWeek({ brandSlug: "stashbox", weekStart: "2026-11-09", mode: "apply", destinations: ["youtube"], runId: "r1", chain: ["x"] }, db, json,
    { modelId: null, invokeNext: async (p) => { next.push(p); } });
  assert.equal(r.status, 404);
  const failed = seen.find((q) => q.sql.includes("ARRAY['planRuns'"));
  assert.equal(failed.params[0], "stashbox");
  assert.equal(failed.params[2], "youtube");
  assert.equal(JSON.parse(failed.params[3]).state, "failed");
  assert.deepEqual(next.map((p) => p.destinations[0]), ["x"], "a failed network still hands over to the next");
});
