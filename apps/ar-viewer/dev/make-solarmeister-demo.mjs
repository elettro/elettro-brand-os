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

const names = { lieferung: "Delivery", montage: "Mounting system", system: "Balcony power plant", fassade: "Facade", bifazial: "Solar modules",
  // the four logo cards: the logo plus a different second picture, one per Brand scan outcome (four clearly different pictures, so they never confuse each other)
  kontakt: "Logo card Contact", film: "Logo card Film", rechner: "Logo card Calculator", rubbeln: "Logo card Scratch" };
const triggers = Object.keys(names).map((n) => {
  const json = JSON.parse(fs.readFileSync(path.join(src, "targets", `${n}.json`), "utf8"));
  const luminanceKey = `${brand}/targets/${n}_luminance.jpg`;
  put(luminanceKey, fs.readFileSync(path.join(src, "targets", `${n}_luminance.jpg`)));
  return { id: n, name: names[n], target: { name: n, json, luminanceKey }, placement: { x: 0.012, y: 0.008, s: 1.04 } };
});
for (let i = 1; i <= 6; i++) put(`${brand}/img/gallery-${i}.jpg`, fs.readFileSync(path.join(src, "img", `gallery-${i}.jpg`)));

// English wording for the demo (the shop's own product names stay as they are).
const eur = (s) => "€" + Number(String(s).replace(/\D/g, "")).toLocaleString("en-GB"); // "1.379 €" -> "€1,379"
const productEn = {
  "max-1000-bifazial-pro-mit-zendure-solarflow-2400-pro": "Max 1000 bifacial Pro + Zendure storage",
  "max-2000-bifazial-pro-mit-zendure-solarflow-2400-pro": "Max 2000 bifacial Pro + Zendure storage",
  "premium-pure-1860-bifazial": "Premium Pure 1860 bifacial",
  "halterung-fassade": "Facade bracket"
};
const actions = [
  { id: "a-video", type: "video", name: "Solar roof video", videoKey: `${brand}/media/solar-roof.mp4`, fit: "crop", loop: true, scale: 1 },
  { id: "a-shop-btn", type: "link", name: "To the shop", label: "To the shop", url: SHOP },
  { id: "a-links", type: "card", name: "Mounting and advice", title: "Mounting & advice", subtitle: "From brackets to batteries: everything for your balcony power plant.", items: [
    { kind: "link", label: "Mounting & brackets", url: `${SHOP}/collections/unterkonstruktion-montage` },
    { kind: "link", label: "Balcony power plants with storage", url: `${SHOP}/collections/balkonkraftwerke-mit-speicher` },
    { kind: "link", label: "Accessories", url: `${SHOP}/collections/zubehoer` },
    { kind: "link", label: "Your own AR for your brand", url: "https://elettro.com/ar" } ] },
  { id: "a-shop", type: "card", name: "Shop", title: "Balcony power plants", subtitle: "Live from the SolarMeister shop.", items: [
    ...shop.map((p) => ({ kind: "product", label: productEn[p.handle] || p.label, url: `${SHOP}/products/${p.handle}`, price: eur(p.price), cta: "View" })),
    { kind: "link", label: "All balcony power plants", url: `${SHOP}/collections/balkonkraftwerke` } ] },
  { id: "a-gallery", type: "gallery", name: "Facade and systems", imageKeys: [1, 6, 2, 3, 4, 5].map((i) => `${brand}/img/gallery-${i}.jpg`), seconds: 3, scale: 1 },
  { id: "a-panel", type: "model", name: "Solar panel", builtin: "solarpanel", scale: 1 },
  { id: "a-modules", type: "link", name: "Solar modules", label: "Solar modules", url: `${SHOP}/collections/solarmodule` },

  // --- the four logo-card outcomes. Contact details are the ones printed on solarmeister-shop.de (Kontakt/Impressum), read 2026-10-26.
  { id: "a-contact", type: "card", name: "Contact", title: "We're here for you", subtitle: "SolarMeister customer service", items: [
    { kind: "link", label: "Call now: +49 1525 972 5120", url: "tel:+4915259725120" },
    { kind: "link", label: "Email support@solarmeister-shop.de", url: "mailto:support@solarmeister-shop.de" },
    { kind: "link", label: "Contact page", url: `${SHOP}/pages/contact` },
    { kind: "link", label: "solarmeister-shop.de", url: SHOP } ] },
  { id: "a-call", type: "link", name: "Call", label: "Call now", url: "tel:+4915259725120" },
  { id: "a-film-shop", type: "link", name: "See balcony power plants", label: "See balcony power plants", url: `${SHOP}/collections/balkonkraftwerke` },
  { id: "a-calc", type: "calculator", name: "Solar calculator", title: "What does a balcony power plant save?", subtitle: "Slide to your electricity use and pick a system.",
    kwh: { min: 1500, max: 6000, step: 100, value: 3200 }, pricePerKwh: 0.35, yieldPerKwp: 900,
    systems: [
      { label: "Max 1000", sub: "+ storage", kwp: 1, selfUse: 0.85, price: Number(shop[0].price.replace(/\D/g, "")), url: `${SHOP}/products/${shop[0].handle}` },
      { label: "Max 2000", sub: "+ storage", kwp: 2, selfUse: 0.8, price: Number(shop[1].price.replace(/\D/g, "")), url: `${SHOP}/products/${shop[1].handle}` } ],
    labels: { use: "Your electricity use per year", saves: "Savings per year", costs: "The system costs", payback: "Pays for itself in", years: "about {n} years", locale: "en-GB" },
    cta: "See this system", note: "Example calculation: 900 kWh per kWp, 35 cents per kWh. No guarantee.", accent: "#3fb62c" },
  { id: "a-scratch", type: "scratch", name: "Scratch card", title: "Scratch to reveal your gift", subtitle: "A surprise discount is waiting.", prize: "5% discount", code: "EXAMPLECODE",
    hint: "Scratch with your finger.", coverText: "SCRATCH", doneText: "Done!", cta: { label: "Redeem in the shop", url: SHOP }, note: "Example code for the demo. Not a real voucher.", accent: "#ffd21f" }
];
const rules = [
  { triggerId: "lieferung", order: 0, actionIds: ["a-video", "a-shop-btn"] },
  { triggerId: "montage", order: 0, actionIds: ["a-links"] },
  { triggerId: "system", order: 0, actionIds: ["a-shop"] },
  { triggerId: "fassade", order: 0, actionIds: ["a-gallery", "a-shop-btn"] },
  { triggerId: "bifazial", order: 0, actionIds: ["a-panel", "a-modules"] },
  { triggerId: "kontakt", order: 0, actionIds: ["a-contact"] },
  { triggerId: "film", order: 0, actionIds: ["a-video", "a-film-shop", "a-call"] },
  { triggerId: "rechner", order: 0, actionIds: ["a-calc"] },
  { triggerId: "rubbeln", order: 0, actionIds: ["a-scratch"] }
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
