// Builds a local fake bucket (.fixture/) from the 8th Wall spike files, using the real manifest builders from the AR Lambda,
// so the viewer is tested against exactly what the API will publish.
//   node dev/make-fixture.mjs <spike-site-dir> <public-base-url>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetManifest, buildBrandManifest, brandManifestKey, setManifestKey } from "../../../services/ar-lambda/manifest.mjs";

const [spike, baseUrl] = process.argv.slice(2);
if (!spike || !baseUrl) { console.error("usage: node dev/make-fixture.mjs <spike-site-dir> <public-base-url>"); process.exit(1); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".fixture");
fs.rmSync(out, { recursive: true, force: true });
const put = (key, data) => { const f = path.join(out, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const copy = (from, key) => put(key, fs.readFileSync(path.join(spike, from)));

const brand = "stashbox";
const names = { "dirty-bird": "Dirty Bird", "super-funk": "Super Funk", "im-waiting": "I'm Waiting" };
const nudge = { "dirty-bird": { x: 0.012, y: 0.008, s: 1.04 }, "super-funk": { x: -0.048, y: -0.027, s: 1.14 }, "im-waiting": { x: 0.012, y: 0.008, s: 1.04 } };
const triggers = [], rules = [];
for (const n of Object.keys(names)) {
  const json = JSON.parse(fs.readFileSync(path.join(spike, `8w/image-targets/${n}.json`), "utf8"));
  const luminanceKey = `${brand}/targets/${n}_luminance.jpg`;
  copy(`8w/image-targets/${n}_luminance.jpg`, luminanceKey);
  triggers.push({ id: n, name: names[n], target: { name: n, json, luminanceKey }, placement: nudge[n] });
}
// Second target for the same Dirty Bird card: the left three-quarters of the artwork (busier: poster wall, lettering), so the engine has more to grip.
{
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "dirty-bird-b");
  const json = JSON.parse(fs.readFileSync(path.join(dir, "target.json"), "utf8"));
  const luminanceKey = `${brand}/targets/dirty-bird-b_luminance.png`;
  put(luminanceKey, fs.readFileSync(path.join(dir, "luminance.png")));
  // The crop is centered 0.125 left of the cover's center (cover = 1 unit tall), so the overlay shifts right by that much.
  triggers.push({ id: "dirty-bird-b", name: "Dirty Bird (left crop)", target: { name: "dirty-bird-b", json, luminanceKey }, placement: { x: 0.125, y: 0, s: 1 } });
}
copy("8w/assets/waiting-9x16-30s.mp4", `${brand}/media/im-waiting.mp4`);
copy("8w/assets/overlay-square.mp4", `${brand}/media/dirty-bird.mp4`);
const actions = [
  { id: "v-iw", type: "video", name: "I'm Waiting", videoKey: `${brand}/media/im-waiting.mp4`, fit: "crop", loop: true, scale: 1 },
  { id: "v-db", type: "video", name: "Dirty Bird", videoKey: `${brand}/media/dirty-bird.mp4`, fit: "crop", loop: true, scale: 1 },
  { id: "l-listen", type: "link", label: "Listen", url: "https://stashbox.com/radio/?song=im-waiting-001b-stashbox" }
];
rules.push(
  { triggerId: "super-funk", order: 0, actionIds: ["v-iw", "l-listen"] },
  { triggerId: "im-waiting", order: 0, actionIds: ["v-iw", "l-listen"] },
  { triggerId: "dirty-bird", order: 0, actionIds: ["v-db", "l-listen"] },
  { triggerId: "dirty-bird-b", order: 0, actionIds: ["v-db", "l-listen"] }
);
const set = { id: "s1", slug: "covers", name: "Covers", triggerIds: triggers.map((t) => t.id) };
const { manifest, problems } = buildSetManifest({ brand, set, triggers, rules, actions, baseUrl });
if (problems.length) { console.error(problems); process.exit(1); }
put(setManifestKey(brand, set.slug), JSON.stringify(manifest, null, 2));
const qrs = [
  { slug: "main", isMain: true, mode: "url", url: "https://stashbox.com/radio" },
  { slug: "covers", isMain: false, mode: "scanner", setId: "s1" }
];
put(brandManifestKey(brand), JSON.stringify(buildBrandManifest({ brand, enabled: true, qrs, sets: [set], actions, baseUrl }), null, 2));
console.log("fixture written to", out);
