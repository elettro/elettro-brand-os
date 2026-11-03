import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runListUntaggedAssets, runTagAssets } from "../services/dev-api-lambda/asset-tagging.mjs";

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
        if (sql.includes('FROM "Asset" WHERE "id"=$1')) return { rows: rows.filter((r) => r.id === params[0]) };
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
