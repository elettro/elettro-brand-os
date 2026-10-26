// Assembles dist/ exactly as it will sit in the bucket root:
//   viewer/*          this app (index.html, viewer.js, logic.js, viewer.css, A-Frame fork)
//   external/xr       8th Wall engine binary (npm @8thwall/engine-binary; face tracking files left out, Lens doesn't use them)
//   external/xrextras 8th Wall xrextras (vendored: the npm build lays its resources out differently from the one we phone-tested)
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const require = createRequire(import.meta.url);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "viewer"), { recursive: true });
for (const f of ["index.html", "viewer.js", "logic.js", "viewer.css"]) cpSync(join(here, "src", f), join(dist, "viewer", f));
// Cache-bust the files that change with every deploy (phones cache them hard).
const v = Date.now().toString(36);
const indexPath = join(dist, "viewer", "index.html");
writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace('/viewer/viewer.css"', `/viewer/viewer.css?v=${v}"`).replace('/viewer/viewer.js"', `/viewer/viewer.js?v=${v}"`));
const jsPath = join(dist, "viewer", "viewer.js");
writeFileSync(jsPath, readFileSync(jsPath, "utf8").replace('"/viewer/logic.js"', `"/viewer/logic.js?v=${v}"`));
cpSync(join(here, "vendor", "8frame-1.5.0.min.js"), join(dist, "viewer", "8frame-1.5.0.min.js"));
cpSync(join(here, "vendor", "xrextras"), join(dist, "external", "xrextras"), { recursive: true });

const engine = join(dirname(require.resolve("@8thwall/engine-binary/package.json")), "dist");
cpSync(engine, join(dist, "external", "xr"), {
  recursive: true,
  filter: (src) => !/xr-face\.js$|face-[a-z-]+\.tflite$/.test(basename(src))
});
console.log("built", dist);
