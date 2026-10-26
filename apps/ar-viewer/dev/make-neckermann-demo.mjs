// Seeds the "neckermann-strom" demo brand: five coffee bags and the logo card all open the same look-only quote form (German).
// Builds a local fake bucket (.fixture-ns/) with the real manifest builders from the AR Lambda; upload it with `aws s3 cp --recursive`.
//   node dev/make-neckermann-demo.mjs <public-base-url>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetManifest, buildBrandManifest, brandManifestKey, setManifestKey } from "../../../services/ar-lambda/manifest.mjs";

const baseUrl = process.argv[2];
if (!baseUrl) { console.error("usage: node dev/make-neckermann-demo.mjs <public-base-url>"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "fixtures", "neckermann-strom");
const out = path.join(here, "..", ".fixture-ns");
fs.rmSync(out, { recursive: true, force: true });
const put = (key, data) => { const f = path.join(out, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

const brand = "neckermann-strom";
const names = { crema: "Feine Crema", buero: "Büro Mischung", privatlabel: "Privatlabel Kaffee", hausmischung: "Hausmischung", espresso: "Espresso Mischung", logo: "Neckermann Strom Logo" };
const triggers = Object.keys(names).map((n) => {
  const json = JSON.parse(fs.readFileSync(path.join(src, "targets", `${n}.json`), "utf8"));
  const luminanceKey = `${brand}/targets/${n}_luminance.jpg`;
  put(luminanceKey, fs.readFileSync(path.join(src, "targets", `${n}_luminance.jpg`)));
  return { id: n, name: names[n], target: { name: n, json, luminanceKey }, placement: { x: 0, y: 0, s: 1 } };
});

// One look-only form for every trigger. Nothing typed into it is sent anywhere.
const actions = [{
  id: "a-quote", type: "form", name: "Strompreis berechnen",
  title: "Dein Strompreis", subtitle: "In 30 Sekunden zum Angebot für dein Zuhause oder dein Unternehmen.",
  toggle: { label: "Kundentyp", options: ["Privatkunde", "Gewerbekunde"] },
  fields: [
    { label: "Postleitzahl", placeholder: "z. B. 80331", mode: "numeric" },
    { label: "Jahresverbrauch", placeholder: "z. B. 3.500", suffix: "kWh/Jahr", mode: "numeric" }
  ],
  cta: "Preis berechnen", note: "Vorschau: Die Berechnung ist in dieser Demo nicht aktiv.", accent: "#43b02a"
}];
const rules = triggers.map((t) => ({ triggerId: t.id, order: 0, actionIds: ["a-quote"] }));
const set = { id: "s-ns", slug: "demo", name: "Neckermann Strom demo", triggerIds: triggers.map((t) => t.id) };
const { manifest, problems } = buildSetManifest({ brand, set, triggers, rules, actions, baseUrl });
if (problems.length) { console.error(problems); process.exit(1); }
put(setManifestKey(brand, set.slug), JSON.stringify(manifest, null, 2));
const qrs = [{ slug: "scan", isMain: true, mode: "scanner", setId: set.id }];
put(brandManifestKey(brand), JSON.stringify(buildBrandManifest({ brand, enabled: true, qrs, sets: [set], actions, baseUrl }), null, 2));
console.log("neckermann fixture written to", out);
