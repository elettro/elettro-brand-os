// Offline: ID-aware Dropbox brands/ cutover planner and ingest cutover gate.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {planMigration, validateMapping, BRANDS} from "../services/dev-api-lambda/brand-root-migration.mjs";

const brandIdBySlug = new Map(BRANDS.map((slug, i) => [slug, `b${i}`]));
const map = (brand, rel, n) => ({brand, oldId: `id:old${n}`, newId: `id:new${n}`, oldPathLower: `/1---elettro-brand-os/${brand}${rel}`,
  newPathLower: `/1---elettro-brand-os/brands/${brand}${rel}`, newPathDisplay: `/1---elettro-brand-os/brands/${brand}${rel.replace("clip", "Clip")}`,
  contentHash: `h${n}`, newRev: `rev${n}`, size: 10});
const roots = BRANDS.map((slug, i) => ({id: `r${i}`, brandId: `b${i}`, storageConnectionId: "c1",
  rootPath: `/1---elettro-brand-os/${slug}`, rootPathLower: `/1---elettro-brand-os/${slug}`}));
const mapping = [map("stashbox", "/live/clip1.mp4", 1), map("stashbox", "/live/clip2.mp4", 2), map("elettro", "/logo.png", 3)];

test("remaps synced and direct-upload assets in place, preserving identity fields", () => {
  const assets = [
    {id: "a1", brandId: "b0", sourceFileId: "id:old1", sourceExternalId: null, sourcePath: "/1---elettro-brand-os/stashbox/live/Clip1.mp4",
      sourcePathLower: "/1---elettro-brand-os/stashbox/live/clip1.mp4", sourceUrl: null, sourceMetadata: {rev: "r0"}, contentHash: "h1"},
    {id: "a3", brandId: "b1", sourceFileId: null, sourceExternalId: "id:old3", sourcePath: null, sourcePathLower: null,
      sourceUrl: "/1---elettro-brand-os/elettro/logo.png", sourceMetadata: {dropboxFileId: "id:old3", path: "/1---elettro-brand-os/elettro/logo.png", rev: "x"}}];
  const plan = planMigration({mapping, assets, roots, brandIdBySlug});
  assert.deepEqual(plan.failures, []);
  assert.equal(plan.updates.length, 2);
  const [u1, u3] = plan.updates;
  assert.equal(u1.set.sourceFileId, "id:new1");
  assert.equal(u1.set.sourceExternalId, null);
  assert.equal(u1.set.sourcePathLower, "/1---elettro-brand-os/brands/stashbox/live/clip1.mp4");
  assert.equal(u1.set.sourceMetadata.rev, "rev1");
  assert.equal(u1.set.sourceMetadata.brandRootMigration.previousDropboxFileId, "id:old1");
  assert.equal(u3.set.sourceFileId, null);
  assert.equal(u3.set.sourceExternalId, "id:new3");
  assert.equal(u3.set.sourceUrl, "/1---elettro-brand-os/brands/elettro/logo.png");
  assert.equal(u3.set.sourceMetadata.dropboxFileId, "id:new3");
  assert.equal(u3.set.sourcePath, null, "null path columns stay null");
  for (const u of plan.updates) assert.deepEqual(Object.keys(u.set).sort(),
    ["sourceExternalId", "sourceFileId", "sourceMetadata", "sourcePath", "sourcePathLower", "sourceUrl"], "only identity/path columns written");
  assert.equal(plan.rootUpdates.length, 6);
  assert.ok(plan.rootUpdates.every(r => r.to.startsWith("/1---elettro-brand-os/brands/")));
});

test("rerun is idempotent: migrated assets and roots are left alone", () => {
  const assets = [{id: "a1", brandId: "b0", sourceFileId: "id:new1", sourceMetadata: {}}];
  const migratedRoots = roots.map((r, i) => ({...r, rootPath: `/1---elettro-brand-os/brands/${BRANDS[i]}`, rootPathLower: `/1---elettro-brand-os/brands/${BRANDS[i]}`}));
  const plan = planMigration({mapping, assets, roots: migratedRoots, brandIdBySlug});
  assert.deepEqual(plan.failures, []);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.alreadyMigrated, 1);
  assert.equal(plan.rootUpdates.length, 0);
});

test("fails closed on duplicates, mixed ids, wrong brand and unexpected roots", () => {
  const cases = [
    [{id: "x", brandId: "b0", sourceFileId: "id:old1"}, {id: "y", brandId: "b0", sourceExternalId: "id:old1"}],
    [{id: "x", brandId: "b0", sourceFileId: "id:old1"}, {id: "y", brandId: "b0", sourceFileId: "id:new1"}],
    [{id: "x", brandId: "b0", sourceFileId: "id:old1", sourceExternalId: "id:new1"}],
    [{id: "x", brandId: "b1", sourceFileId: "id:old1"}]];
  for (const assets of cases) assert.ok(planMigration({mapping, assets, roots, brandIdBySlug}).failures.length, JSON.stringify(assets));
  const odd = roots.map((r, i) => i ? r : {...r, rootPath: "/somewhere", rootPathLower: "/somewhere"});
  assert.ok(planMigration({mapping, assets: [], roots: odd, brandIdBySlug}).failures.some(f => f.includes("unexpected root")));
});

test("unmapped historical assets are reported, never rewritten or matched by name", () => {
  const assets = [{id: "s", brandId: "b0", sourceFileId: "id:gone", sourcePath: "/1---elettro-brand-os/stashbox/live/clip1.mp4", sourceMetadata: {}}];
  const plan = planMigration({mapping, assets, roots, brandIdBySlug});
  assert.deepEqual(plan.failures, []);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unmapped.length, 1);
});

test("mapping validation rejects path drift and reused ids", () => {
  assert.deepEqual(validateMapping(mapping), []);
  assert.ok(validateMapping([{...mapping[0], newPathLower: "/1---elettro-brand-os/brands/stashbox/other.mp4"}]).length);
  assert.ok(validateMapping([mapping[0], {...mapping[1], newId: mapping[0].newId}]).length);
  assert.ok(validateMapping([{...mapping[0], brand: "creative-assets"}]).length);
});

test("ingest only indexes files under the database-registered root and matches either id column", () => {
  const api = fs.readFileSync(new URL("../services/dev-api-lambda/index.mjs", import.meta.url), "utf8");
  // Matches any root registered to the brand (the shared library has audio + stock-graphics).
  assert.match(api, /pathLower\.startsWith\(`\$\{r\.path\}\/`\)/);
  assert.match(api, /\("sourceFileId" = \$2 OR "sourceExternalId" = \$2\)/);
  assert.match(api, /event\.action === "migrate-dropbox-brand-roots-20261017" && !event\.requestContext/);
});

test("every deployed Dropbox writer uses the brands/ roots", () => {
  for (const f of ["../services/dropbox-upload-lambda/index.mjs", "../services/dropbox-sync-lambda/claude-folder-relay.mjs"]) {
    const s = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(s.includes("/1---elettro-brand-os/brands/"), f);
  }
});

test("sync worker brand browse, write and upload verification use brands/ roots", () => {
  const s = fs.readFileSync(new URL("../services/dropbox-sync-lambda/index.mjs", import.meta.url), "utf8");
  assert.equal((s.match(/\$\{DROPBOX_ROOT\}\/brands\/\$\{brand\}/g) || []).length, 3);
  assert.doesNotMatch(s, /\$\{DROPBOX_ROOT\}\/\$\{brand\}/);
});

test("brand media reset is IAM-only, backs up first, and preserves publishing history", () => {
  const api = fs.readFileSync(new URL("../services/dev-api-lambda/index.mjs", import.meta.url), "utf8");
  const reset = fs.readFileSync(new URL("../services/dev-api-lambda/brand-media-reset.mjs", import.meta.url), "utf8");
  assert.match(api, /event\.action === "reset-brand-media-20261017" && !event\.requestContext/);
  assert.ok(reset.indexOf("CREATE TABLE IF NOT EXISTS") < reset.indexOf('DELETE FROM "Asset"'));
  assert.match(reset, /AND NOT \(\$\{history\}\)/);
  assert.match(reset, /mode === "apply" \? "apply" : "dry-run"/);
});
