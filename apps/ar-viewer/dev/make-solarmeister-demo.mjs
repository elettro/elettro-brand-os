// Seeds the "solarmeister" demo brand: five SolarMeister shop photos, five different experiences (German text).
// Builds a local fake bucket (.fixture-sm/) with the real manifest builders from the AR Lambda; upload it with `aws s3 cp --recursive`.
//   node dev/make-solarmeister-demo.mjs <public-base-url>
// Products, prices and pictures were read from the public shop catalog (solarmeister-shop.de/products.json), see fixtures/solarmeister/shop.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetManifest, buildBrandManifest, brandManifestKey, setManifestKey } from "../../../services/ar-lambda/manifest.mjs";

const baseUrl = process.argv[2];
if (!baseUrl) { console.error("usage: node dev/make-solarmeister-demo.mjs <public-base-url>"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "fixtures", "solarmeister");
const out = path.join(here, "..", ".fixture-sm");
fs.rmSync(out, { recursive: true, force: true });
const put = (key, data) => { const f = path.join(out, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

const brand = "solarmeister";
const SHOP = "https://solarmeister-shop.de";
const shop = JSON.parse(fs.readFileSync(path.join(src, "shop.json"), "utf8")).products;

const names = { lieferung: "Lieferung", montage: "Montagesystem", system: "Balkonkraftwerk", fassade: "Fassade", bifazial: "Bifaziale Module" };
const triggers = Object.keys(names).map((n) => {
  const json = JSON.parse(fs.readFileSync(path.join(src, "targets", `${n}.json`), "utf8"));
  const luminanceKey = `${brand}/targets/${n}_luminance.jpg`;
  put(luminanceKey, fs.readFileSync(path.join(src, "targets", `${n}_luminance.jpg`)));
  return { id: n, name: names[n], target: { name: n, json, luminanceKey }, placement: { x: 0.012, y: 0.008, s: 1.04 } };
});
for (let i = 1; i <= 6; i++) put(`${brand}/img/gallery-${i}.jpg`, fs.readFileSync(path.join(src, "img", `gallery-${i}.jpg`)));

const actions = [
  { id: "a-video", type: "video", name: "Solar-Dach Video", videoKey: `${brand}/media/solar-roof.mp4`, fit: "crop", loop: true, scale: 1 },
  { id: "a-shop-btn", type: "link", name: "Zum Shop", label: "Zum Shop", url: SHOP },
  { id: "a-links", type: "card", name: "Montage und Beratung", title: "Montage & Beratung", subtitle: "Vom Halter bis zum Speicher: alles für dein Balkonkraftwerk.", items: [
    { kind: "link", label: "Unterkonstruktion & Montage", url: `${SHOP}/collections/unterkonstruktion-montage` },
    { kind: "link", label: "Balkonkraftwerke mit Speicher", url: `${SHOP}/collections/balkonkraftwerke-mit-speicher` },
    { kind: "link", label: "Zubehör", url: `${SHOP}/collections/zubehoer` },
    { kind: "link", label: "Eigenes AR für deine Marke", url: "https://elettro.com/ar" } ] },
  { id: "a-shop", type: "card", name: "Shop", title: "Balkonkraftwerke", subtitle: "Live aus dem SolarMeister-Shop.", items: [
    ...shop.map((p) => ({ kind: "product", label: p.label, url: `${SHOP}/products/${p.handle}`, price: p.price, cta: "Ansehen" })),
    { kind: "link", label: "Alle Balkonkraftwerke", url: `${SHOP}/collections/balkonkraftwerke` } ] },
  { id: "a-gallery", type: "gallery", name: "Fassade und Systeme", imageKeys: [1, 6, 2, 3, 4, 5].map((i) => `${brand}/img/gallery-${i}.jpg`), seconds: 3, scale: 1 },
  { id: "a-panel", type: "model", name: "Solarmodul", builtin: "solarpanel", scale: 1 },
  { id: "a-modules", type: "link", name: "Solarmodule", label: "Solarmodule", url: `${SHOP}/collections/solarmodule` }
];
const rules = [
  { triggerId: "lieferung", order: 0, actionIds: ["a-video", "a-shop-btn"] },
  { triggerId: "montage", order: 0, actionIds: ["a-links"] },
  { triggerId: "system", order: 0, actionIds: ["a-shop"] },
  { triggerId: "fassade", order: 0, actionIds: ["a-gallery", "a-shop-btn"] },
  { triggerId: "bifazial", order: 0, actionIds: ["a-panel", "a-modules"] }
];
const set = { id: "s-sm", slug: "demo", name: "SolarMeister AR demo", triggerIds: triggers.map((t) => t.id) };
const { manifest, problems } = buildSetManifest({ brand, set, triggers, rules, actions, baseUrl });
if (problems.length) { console.error(problems); process.exit(1); }
// Product pictures come straight from Shopify's own image host.
const shopCard = manifest.triggers.find((t) => t.id === "system").actions.find((a) => a.type === "card");
shop.forEach((p, i) => { shopCard.items[i].image = p.image; });
put(setManifestKey(brand, set.slug), JSON.stringify(manifest, null, 2));
const qrs = [{ slug: "scan", isMain: true, mode: "scanner", setId: set.id }];
put(brandManifestKey(brand), JSON.stringify(buildBrandManifest({ brand, enabled: true, qrs, sets: [set], actions, baseUrl }), null, 2));
console.log("solarmeister fixture written to", out);
