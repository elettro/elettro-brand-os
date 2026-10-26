// Seeds the public "elettro" demo brand behind elettro.com/ar: five Stashbox covers, five different experiences.
// Builds a local fake bucket (.fixture-ar/) with the real manifest builders from the Lens Lambda; upload it with `aws s3 cp --recursive`.
//   node dev/make-ar-demo.mjs <public-base-url>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetManifest, buildBrandManifest, brandManifestKey, setManifestKey } from "../../../services/lens-lambda/manifest.mjs";

const baseUrl = process.argv[2];
if (!baseUrl) { console.error("usage: node dev/make-ar-demo.mjs <public-base-url>"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "fixtures", "ar-demo");
const out = path.join(here, "..", ".fixture-ar");
fs.rmSync(out, { recursive: true, force: true });
const put = (key, data) => { const f = path.join(out, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

const brand = "elettro";
const radio = (song) => `https://stashbox.com/radio/?song=${song}`;

// Real products read from the public Stashbox Shopify catalog (stashbox.ai/products.json) on 2026-10-26.
const shop = [
  { handle: "official-squidly-cole-reggae-drummer-black-shoes-signature-series", label: "Squidly Cole Reggae Drummer Shoes", price: "$69.99", image: "https://cdn.shopify.com/s/files/1/0779/3383/8631/files/15044189775330199458_2048.jpg?v=1699219375" },
  { handle: "rasta-drummer-green-yellow-red-color-explosion-custom-mens-sneakers-music-design-001", label: "Rasta Drummer Color Explosion Sneakers", price: "$74.99", image: "https://cdn.shopify.com/s/files/1/0779/3383/8631/files/3739583886957042612_2048.jpg?v=1701957065" },
  { handle: "rastaman-surfing-wave-green-yellow-red-custom-mens-sneakers-surfboard-design-005", label: "Rastaman Surfing Wave Sneakers", price: "$74.99", image: "https://cdn.shopify.com/s/files/1/0779/3383/8631/files/13936563503244118633_2048.jpg?v=1691673940" }
];

const names = { "im-waiting": "I'm Waiting", "let-me-down": "Let Me Down", "freedom-street": "Freedom Street", "hold-jamaica": "Hold Jamaica Tonight", "marie-claude": "Marie-Claude" };
const triggers = Object.keys(names).map((n) => {
  const json = JSON.parse(fs.readFileSync(path.join(src, "targets", `${n}.json`), "utf8"));
  const luminanceKey = `${brand}/targets/${n}_luminance.jpg`;
  put(luminanceKey, fs.readFileSync(path.join(src, "targets", `${n}_luminance.jpg`)));
  return { id: n, name: names[n], target: { name: n, json, luminanceKey }, placement: { x: 0.012, y: 0.008, s: 1.04 } };
});
for (let i = 1; i <= 4; i++) put(`${brand}/img/gallery-${i}.jpg`, fs.readFileSync(path.join(src, "img", `gallery-${i}.jpg`)));

const actions = [
  { id: "a-video", type: "video", name: "I'm Waiting video", videoKey: `${brand}/media/im-waiting.mp4`, fit: "crop", loop: true, scale: 1 },
  { id: "a-listen-iw", type: "link", name: "Listen I'm Waiting", label: "Listen", url: radio("im-waiting-001b-stashbox") },
  { id: "a-links", type: "card", name: "Link page", title: "Let Me Down", subtitle: "Stashbox, live. Every link a brand wants on one screen.", items: [
    { kind: "link", label: "Play it on Stashbox Radio", url: radio("let-me-down-10b-stashbox") },
    { kind: "link", label: "Browse every Stashbox song", url: "https://stashbox.com/radio" },
    { kind: "link", label: "Shop Stashbox", url: "https://stashbox.ai" },
    { kind: "link", label: "Make your own Lens", url: "https://elettro.com/ar" } ] },
  { id: "a-shop", type: "card", name: "Shop", title: "Shop Stashbox", subtitle: "Live from the Stashbox Shopify store.", items: [
    ...shop.map((p) => ({ kind: "product", label: p.label, url: `https://stashbox.ai/products/${p.handle}`, price: p.price, cta: "Buy now" })),
    { kind: "link", label: "See everything", url: "https://stashbox.ai" } ] },
  { id: "a-gallery", type: "gallery", name: "Cover wall", imageKeys: [1, 2, 3, 4].map((i) => `${brand}/img/gallery-${i}.jpg`), seconds: 2.5, scale: 1 },
  { id: "a-listen-hj", type: "link", name: "Listen Hold Jamaica", label: "Listen", url: radio("hold-jamaica-tonight-05b-stashbox") },
  { id: "a-vinyl", type: "model", name: "Vinyl", builtin: "vinyl", scale: 1 },
  { id: "a-listen-mc", type: "link", name: "Listen Marie-Claude", label: "Listen", url: radio("marie-claude-stashbox") }
];
const rules = [
  { triggerId: "im-waiting", order: 0, actionIds: ["a-video", "a-listen-iw"] },
  { triggerId: "let-me-down", order: 0, actionIds: ["a-links"] },
  { triggerId: "freedom-street", order: 0, actionIds: ["a-shop"] },
  { triggerId: "hold-jamaica", order: 0, actionIds: ["a-gallery", "a-listen-hj"] },
  { triggerId: "marie-claude", order: 0, actionIds: ["a-vinyl", "a-listen-mc"] }
];
const set = { id: "s-ar", slug: "ar", name: "Elettro AR demo", triggerIds: triggers.map((t) => t.id) };
const { manifest, problems } = buildSetManifest({ brand, set, triggers, rules, actions, baseUrl });
if (problems.length) { console.error(problems); process.exit(1); }
// Product pictures come straight from Shopify's own image host.
const shopCard = manifest.triggers.find((t) => t.id === "freedom-street").actions.find((a) => a.type === "card");
shop.forEach((p, i) => { shopCard.items[i].image = p.image; });
put(setManifestKey(brand, set.slug), JSON.stringify(manifest, null, 2));
const qrs = [{ slug: "ar", isMain: true, mode: "scanner", setId: set.id }];
put(brandManifestKey(brand), JSON.stringify(buildBrandManifest({ brand, enabled: true, qrs, sets: [set], actions, baseUrl }), null, 2));
console.log("demo fixture written to", out);
