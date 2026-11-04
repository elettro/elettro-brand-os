const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("stock graphics setup and tagging are IAM-only and dry-run by default", () => {
  const lib = read("services/dev-api-lambda/shared-stock-graphics.mjs");
  assert.match(lib, /Direct IAM invocation required/);
  assert.match(lib, /event\.mode === "apply" \? "apply" : "dry-run"/);
  assert.match(lib, /LIBRARY_GRAPHICS_ROOT = "\/1---elettro-brand-os\/creative-assets\/stock-graphics"/);
  const api = read("services/dev-api-lambda/index.mjs");
  assert.match(api, /setup-shared-stock-graphics-20261101" && !event\.requestContext && !event\.rawPath && !event\.path/);
  assert.match(api, /tag-shared-stock-graphics-20261101" && !event\.requestContext && !event\.rawPath && !event\.path/);
});

test("only the Christmas and New Year stock-video subtrees are indexed; ingest matches any registered root of the library", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  const lib = read("services/dev-api-lambda/shared-stock-graphics.mjs");
  assert.match(lib, /creative-assets\/stock-videos\/christmas"/);
  assert.match(lib, /creative-assets\/stock-videos\/new-years-2027"/);
  // never the whole stock-videos folder (it also holds personal clips)
  assert.doesNotMatch(lib, /creative-assets\/stock-videos"/);
  assert.match(api, /LIBRARY_VIDEO_ROOTS\.map/);
  assert.match(api, /rootsByBrandId/);
});
