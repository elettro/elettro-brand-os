import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAddSectorMatchTag } from "../services/dev-api-lambda/planner-sector-tags.mjs";

const json = (status, body) => ({ status, body });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const settings = () => ({ planner: { cooldowns: { assetDays: 30 }, sectors: [
  { slug: "radio-blog", match: { tagsAny: ["ecosystem", "explainer"] } }, { slug: "merch", match: { tagsAny: ["merch"] } }] } });
function db(s) {
  const writes = [];
  return { writes, connect: async () => ({ query: async (sql, params) => {
    if (sql.startsWith("UPDATE")) { writes.push(params); return { rows: [] }; }
    return { rows: [{ id: "b1", settings: s }] };
  }, end: async () => {} }) };
}

test("refuses HTTP invocation", async () => {
  assert.equal((await runAddSectorMatchTag({ rawPath: "/x" }, async () => { throw new Error("no"); }, json)).status, 403);
});
test("dry run reports the change and writes nothing", async () => {
  const d = db(settings());
  const r = await runAddSectorMatchTag({ brandSlug: "stashbox", sector: "radio-blog", tag: "radio-blog" }, d.connect, json);
  assert.deepEqual(r.body.after, ["ecosystem", "explainer", "radio-blog"]);
  assert.equal(d.writes.length, 0);
});
test("apply changes only the named sector", async () => {
  const d = db(settings());
  await runAddSectorMatchTag({ mode: "apply", brandSlug: "stashbox", sector: "radio-blog", tag: "Radio-Blog" }, d.connect, json);
  const next = JSON.parse(d.writes[0][1]);
  assert.deepEqual(next[0].match.tagsAny, ["ecosystem", "explainer", "radio-blog"]);
  assert.deepEqual(next[1].match.tagsAny, ["merch"]);
});
test("an existing tag is a no-op, an unknown sector is 404", async () => {
  const d = db(settings());
  assert.equal((await runAddSectorMatchTag({ mode: "apply", brandSlug: "s", sector: "merch", tag: "merch" }, d.connect, json)).body.changed, false);
  assert.equal((await runAddSectorMatchTag({ brandSlug: "s", sector: "nope", tag: "x" }, d.connect, json)).status, 404);
  assert.equal(d.writes.length, 0);
});
test("wired into index, zip list and syntax check", () => {
  assert.match(read("services/dev-api-lambda/index.mjs"), /add-sector-match-tag-20261103" && !event\.requestContext && !event\.rawPath && !event\.path/);
  assert.ok(read("services/dev-api-lambda/package.json").includes("planner-sector-tags.mjs"));
  assert.ok(read(".github/workflows/build-dev-api-lambda.yml").includes("node --check planner-sector-tags.mjs"));
});
