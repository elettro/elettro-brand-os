// Offline regression: the shared audio library is indexed under creative-assets/audio only,
// with an 'audio' asset kind and per-asset allowed brands. Stock video/graphics stay unindexed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(base, p), "utf8");

test("audio files are recognised and only the audio subtree of creative-assets is a root", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  const lib = read("services/dev-api-lambda/shared-audio-library.mjs");
  assert.match(api, /wav\|mp3\|m4a[^)]*\)\$\/i\.test\(lower\)\) return "audio"/);
  assert.ok(api.includes("[LIBRARY_SLUG, LIBRARY_AUDIO_ROOT]"));
  assert.ok(lib.includes('LIBRARY_AUDIO_ROOT = "/1---elettro-brand-os/creative-assets/audio"'));
  assert.ok(!/stock-videos|stock-graphics/.test(lib.split("\n").filter(l => !l.startsWith("//")).join("\n")));
});

test("library owner is never an active brand and setup is IAM-only with a dry run", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  const lib = read("services/dev-api-lambda/shared-audio-library.mjs");
  assert.ok(lib.includes("'library'"));
  assert.ok(lib.includes('event.mode === "apply" ? "apply" : "dry-run"'));
  assert.match(api, /setup-shared-audio-library-20261017" && !event\.requestContext && !event\.rawPath && !event\.path/);
});

test("allowed brands and duration are writable through bulk metadata", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  assert.ok(api.includes('addSet("allowedBrandSlugs", metadata.allowedBrandSlugs)'));
  assert.ok(api.includes('addSet("durationMs", metadata.durationMs)'));
});

test("schemas and packaging know about audio", () => {
  assert.ok(read("services/dev-api-lambda/init.sql").includes("'carousel','audio'"));
  assert.ok(read("packages/database/prisma/schema.prisma").includes("allowedBrandSlugs"));
  // Each module must be in the zip list; their order (and neighbours) changes whenever a new module is added.
  const workflow = read(".github/workflows/build-dev-api-lambda.yml");
  const zipList = workflow.slice(workflow.indexOf("zip -r elettro-brand-os-dev-api.zip"));
  for (const file of ["shared-audio-library.mjs", "shared-stock-graphics.mjs", "document-asset-kind.mjs", "init.sql"]) assert.ok(zipList.includes(` ${file} `), `${file} is missing from the dev-api zip list`);
});

test("shared-library assets honour allowedBrandSlugs in the asset list, single asset and content-pool stock view", () => {
  const src = read("services/dev-api-lambda/db-main.mjs");
  // one restriction per shared branch: empty list = open to all; otherwise the requested brands must overlap
  const hits = src.match(/COALESCE\(cardinality\(a\."allowedBrandSlugs"\),0\) = 0/g) || [];
  assert.equal(hits.length, 3);
  assert.equal((src.match(/a\."allowedBrandSlugs" && \$[12]::text\[\]/g) || []).length, 3);
  // the library's own view (brands=creative-assets) matches on the first predicate and stays unrestricted
  assert.ok(src.includes('b."slug" = ANY($1::text[])'));
});
