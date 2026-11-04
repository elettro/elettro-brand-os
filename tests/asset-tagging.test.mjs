import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runListUntaggedAssets, runTagAssets, runRetireAssets } from "../services/dev-api-lambda/asset-tagging.mjs";

const json = (status, body) => ({ status, body });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ID = "11111111-1111-1111-1111-111111111111";

function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    connect: async () => ({
      query: async (sql, params) => {
        if (sql.startsWith("UPDATE")) { updates.push(params); return { rows: [] }; }
        if (sql.includes('WHERE a."id"=$1')) return { rows: rows.filter((r) => r.id === params[0]) };
        if (sql.includes('a."sourcePathLower"=$2')) return { rows: rows.filter((r) => r.sourcePath && r.sourcePath.toLowerCase() === params[1]) };
        return { rows: [] };
      },
      end: async () => {}
    })
  };
}

test("actions refuse HTTP invocation", async () => {
  const noDb = async () => { throw new Error("must not connect"); };
  assert.equal((await runListUntaggedAssets({ rawPath: "/x" }, noDb, json)).status, 403);
  assert.equal((await runTagAssets({ requestContext: {} }, noDb, json)).status, 403);
});

test("tagging is a dry run by default and writes nothing", async () => {
  const db = fakeDb([{ id: ID, tags: ["a"], title: null, topic: null, creativeNotes: null, retiredAt: null }]);
  const r = await runTagAssets({ items: [{ assetId: ID, tags: ["B", "a"], title: "T" }] }, db.connect, json);
  assert.equal(r.body.mode, "dry-run");
  assert.equal(r.body.results[0].status, "would-tag");
  assert.deepEqual(r.body.results[0].tags, ["a", "B"]);
  assert.equal(db.updates.length, 0);
});

test("apply merges tags and only fills empty fields", async () => {
  const db = fakeDb([{ id: ID, tags: ["keep"], title: "Old", topic: null, creativeNotes: null, retiredAt: null }]);
  const r = await runTagAssets({ mode: "apply", items: [{ assetId: ID, tags: ["new"], title: "New", topic: "Topic" }] }, db.connect, json);
  assert.equal(r.body.results[0].status, "tagged");
  assert.deepEqual(db.updates[0], [ID, "Old", "Topic", ["keep", "new"], null]);
});

test("retired, missing and bad entries are skipped", async () => {
  const db = fakeDb([{ id: ID, tags: [], title: null, topic: null, creativeNotes: null, retiredAt: new Date() }]);
  const r = await runTagAssets({ mode: "apply", items: [{ assetId: ID, tags: ["x"] }, { assetId: "22222222-2222-2222-2222-222222222222", tags: ["x"] }, { assetId: "bad", tags: [] }] }, db.connect, json);
  assert.deepEqual(r.body.results.map((x) => x.status), ["retired", "not-found", "rejected"]);
  assert.equal(db.updates.length, 0);
});

test("more than 200 items is rejected", async () => {
  const items = Array.from({ length: 201 }, () => ({ assetId: ID, tags: ["x"] }));
  assert.equal((await runTagAssets({ items }, async () => { throw new Error("no"); }, json)).status, 400);
});

test("wired into index, zip list and syntax check", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  assert.match(api, /list-untagged-assets-20261103" && !event\.requestContext && !event\.rawPath && !event\.path/);
  assert.match(api, /tag-assets-20261103" && !event\.requestContext && !event\.rawPath && !event\.path/);
  assert.ok(read("services/dev-api-lambda/package.json").includes("asset-tagging.mjs"));
  assert.ok(read(".github/workflows/build-dev-api-lambda.yml").includes("node --check asset-tagging.mjs"));
});

test("eligibility sets an annual window, and a bad one is rejected", async () => {
  const db = fakeDb([{ id: ID, tags: [], title: null, topic: null, creativeNotes: null, retiredAt: null }]);
  const ok = await runTagAssets({ mode: "apply", eligibility: { type: "annual", fromMmdd: 1031, untilMmdd: 1031 }, items: [{ assetId: ID, tags: ["halloween"] }] }, db.connect, json);
  assert.equal(ok.body.results[0].status, "tagged");
  const last = db.updates[db.updates.length - 1];
  assert.deepEqual(last, [ID, "annual", 1031, 1031]);
  const before = db.updates.length;
  const bad = await runTagAssets({ mode: "apply", eligibility: { type: "annual", fromMmdd: 1332, untilMmdd: 1031 }, items: [{ assetId: ID, tags: ["x"] }] }, db.connect, json);
  assert.equal(bad.body.results[0].status, "rejected");
  assert.equal(db.updates.length, before);
});

test("allowedDestinations can open an asset to every network, and bad values are rejected", async () => {
  const db = fakeDb([{ id: ID, tags: ["gmb"], title: null, topic: null, creativeNotes: null, retiredAt: null, allowedDestinations: ["gmb"] }]);
  const r = await runTagAssets({ mode: "apply", allowedDestinations: [], items: [{ assetId: ID, tags: ["show-promo"] }] }, db.connect, json);
  assert.deepEqual(r.body.results[0].allowedDestinations, { before: ["gmb"], after: [] });
  assert.deepEqual(db.updates[db.updates.length - 1], [ID, []]);
  const before = db.updates.length;
  const bad = await runTagAssets({ mode: "apply", allowedDestinations: ["ok", "bad name!"], items: [{ assetId: ID, tags: ["x"] }] }, db.connect, json);
  assert.equal(bad.body.results[0].status, "rejected");
  assert.equal(db.updates.length, before);
});

test("a freshly synced file is found by path, filled in and marked approved", async () => {
  const db = fakeDb([{ id: ID, sourcePath: "/1---elettro-brand-os/brands/stashbox/merch/video/9x16/now-spinning/a.mp4", tags: [], title: null, topic: null,
    creativeNotes: null, creativeFamily: null, contentGroup: null, retiredAt: null, approvalStatus: "pending", ingestStatus: "raw" }]);
  const item = { brandSlug: "stashbox", sourcePath: "/1---Elettro-Brand-OS/brands/stashbox/merch/video/9x16/now-spinning/A.mp4", tags: ["merch", "genre:reggae"],
    title: "T", creativeFamily: "Stashbox Merch", contentGroup: "merch-month-2" };
  const dry = await runTagAssets({ items: [item], markApproved: true }, db.connect, json);
  assert.equal(dry.body.results[0].status, "would-tag");
  assert.deepEqual(dry.body.results[0].approval, { before: "pending/raw", after: "approved/ready" });
  assert.equal(db.updates.length, 0);
  const r = await runTagAssets({ mode: "apply", items: [item], markApproved: true }, db.connect, json);
  assert.equal(r.body.results[0].status, "tagged");
  assert.ok(db.updates.some((u) => u.length === 3 && u[1] === "Stashbox Merch" && u[2] === "merch-month-2"));
  assert.ok(db.updates.some((u) => u.length === 1 && u[0] === ID), "approval update ran");
});

test("without markApproved the approval status is never touched", async () => {
  const db = fakeDb([{ id: ID, tags: [], title: null, topic: null, creativeNotes: null, retiredAt: null, approvalStatus: "pending", ingestStatus: "raw" }]);
  const r = await runTagAssets({ mode: "apply", items: [{ assetId: ID, tags: ["x"] }] }, db.connect, json);
  assert.equal(r.body.results[0].approval, undefined);
  assert.ok(!db.updates.some((u) => u.length === 1));
});

test("retire-assets refuses HTTP, is a dry run by default and only retires, never deletes", async () => {
  const noDb = async () => { throw new Error("must not connect"); };
  assert.equal((await runRetireAssets({ rawPath: "/x" }, noDb, json)).status, 403);
  const calls = [];
  const db = async () => ({
    query: async (sql, params) => {
      calls.push(sql);
      if (sql.startsWith("SELECT")) return { rows: params[1] === "/a.mp3" ? [{ id: ID, retiredAt: null }] : params[1] === "/b.mp3" ? [{ id: ID, retiredAt: new Date() }] : [] };
      return { rows: [] };
    },
    end: async () => {}
  });
  const items = [{ brandSlug: "creative-assets", sourcePath: "/A.mp3" }, { brandSlug: "creative-assets", sourcePath: "/B.mp3" }, { brandSlug: "creative-assets", sourcePath: "/c.mp3" }, { sourcePath: "/d.mp3" }];
  const dry = await runRetireAssets({ mode: "dry-run", items }, db, json);
  assert.deepEqual(dry.body.summary, { "would-retire": 1, "already-retired": 1, "not-found": 1, rejected: 1 });
  assert.equal(calls.filter((q) => q.startsWith("UPDATE")).length, 0);
  const applied = await runRetireAssets({ mode: "apply", items }, db, json);
  assert.equal(applied.body.summary.retired, 1);
  assert.equal(calls.filter((q) => q.startsWith("UPDATE")).length, 1);
  assert.ok(!calls.some((q) => /DELETE/i.test(q)));
});

test("retire-assets action is routed IAM-only in the dev-api", () => {
  assert.match(read("services/dev-api-lambda/index.mjs"), /retire-assets-20261104" && !event\.requestContext && !event\.rawPath && !event\.path/);
});
