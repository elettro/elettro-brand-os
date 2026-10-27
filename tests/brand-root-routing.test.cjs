// Offline regression: Dropbox brand media live under the brands/ directory.
// Cross-platform business rules and shared-asset roots must stay out of that directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const base = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(base,p),"utf8");
const brands = ["stashbox","elettro","solarmeister","neckermann-strom","weightlossdavie","therasbox","pianomusicsoothing","reggaeland","google-review"];
test("six brands use the consolidated media root",()=>{
 const config = read("apps/web/lib/brand-config.ts");
 const api = read("services/dev-api-lambda/index.mjs");
 const db = read("services/dev-api-lambda/db-main.mjs");
 const upload = read("services/dev-api-lambda/dropbox-upload-session.mjs");
 for(const brand of brands){
  const want = "/1---elettro-brand-os/brands/"+brand;
  for(const [source,body] of [["config",config],["API",api],["DB",db],["upload",upload]]){
   assert.ok(body.includes(want),source+" missing "+want);
  }
 }
});
test("browser, worker, folder moves and smoke checks use the new brand root",()=>{
 for(const f of ["apps/web/app/assets/add/dropbox-folder-browser.tsx",
  "apps/web/app/assets/add/intake-client.tsx",
  "services/worker/src/dropbox-folder-listing.ts",
  "services/dev-api-lambda/claude-folder-ops.mjs",
  "scripts/check-ai-mcp.mjs"]){
  assert.ok(read(f).includes("/1---elettro-brand-os/brands/"),f);
 }
});
test("global Dropbox crawl and shared creative storage do not move under brands",()=>{
 assert.ok(read("services/dropbox-sync-lambda/index.mjs").includes('DROPBOX_ROOT = "/1---elettro-brand-os"'));
 assert.ok(read("apps/web/app/api/dropbox/stock-folders/route.ts").includes("/1---elettro-brand-os/creative-assets"));
 assert.ok(read("apps/web/lib/ai-gateway.ts").includes("/1---elettro-brand-os/creative-assets"));
});
test("historical path display still accepts old prefixes pending Dropbox ID reconciliation",()=>{
 const s=read("apps/web/app/assets/asset-library-client.tsx");
 assert.ok(s.includes('"/1---elettro-brand-os/brands/"'));
 assert.ok(s.includes('"/1---elettro-brand-os/"'));
});
