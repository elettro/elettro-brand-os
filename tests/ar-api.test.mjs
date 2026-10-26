import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../services/ar-lambda/app.mjs";
import { gate } from "../services/ar-lambda/api-gate.mjs";
import * as v from "../services/ar-lambda/validate.mjs";
import { buildBrandManifest, buildSetManifest, stubManifest } from "../services/ar-lambda/manifest.mjs";

const KEY = "ar-test-key";
const BASE = "https://ar.example.test";

function fakes() {
  const rows = new Map(); // `${brand}|${sk}` -> item
  const objects = new Map(); // key -> { size, contentType }
  const written = new Map();
  const invalidated = [];
  const store = {
    async list(brand) { return [...rows].filter(([k]) => k.startsWith(`${brand}|`)).map(([k, item]) => ({ ...item, PK: `BRAND#${brand}`, SK: k.split("|")[1] })); },
    async get(brand, sk) { return rows.get(`${brand}|${sk}`) || null; },
    async put(brand, sk, data) { rows.set(`${brand}|${sk}`, structuredClone(data)); },
    async del(brand, sk) { rows.delete(`${brand}|${sk}`); },
    async add(brand, sk, { inc = {}, set = {}, setIfMissing = {} }) {
      const k = `${brand}|${sk}`, cur = rows.get(k) || {};
      for (const [fld, n] of Object.entries(inc)) cur[fld] = (cur[fld] || 0) + n;
      Object.assign(cur, set);
      for (const [fld, val] of Object.entries(setIfMissing)) if (cur[fld] === undefined) cur[fld] = val;
      rows.set(k, cur);
    }
  };
  const files = {
    async presignPut({ key }) { return { url: `https://s3.example.test/${key}?sig=1` }; },
    async head(key) { return objects.get(key) || null; },
    async putJson(key, obj) { written.set(key, structuredClone(obj)); },
    async getJson(key) { return written.has(key) ? structuredClone(written.get(key)) : null; }
  };
  const cdn = { async invalidate(paths) { invalidated.push(...paths); } };
  let n = 0;
  const app = createApp({ store, files, cdn, config: { publicBaseUrl: BASE, apiKey: KEY, now: () => new Date(Date.UTC(2026, 9, 25, 12, 0, n++)) } });
  return { app, rows, objects, written, invalidated };
}

const ev = (method, path, body, headers = { "x-elettro-connect-key": KEY }) => ({
  rawPath: path, headers, requestContext: { http: { method, path } }, body: body === undefined ? undefined : JSON.stringify(body)
});
const call = async (f, method, path, body, headers) => {
  const r = await f.app.handle(ev(method, path, body, headers));
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const enable = (f, brand = "stashbox") => call(f, "PUT", `/ar/brands/${brand}/entitlement`, { arEnabled: true });

// A ready-to-publish setup: one trigger with a target, a video action, a rule, and a set.
async function readySet(f, brand = "stashbox") {
  await enable(f, brand);
  f.objects.set(`${brand}/targets/db_lum.jpg`, { size: 70000, contentType: "image/jpeg" });
  f.objects.set(`${brand}/video/clip.mp4`, { size: 9_000_000, contentType: "video/mp4" });
  const t = (await call(f, "POST", `/ar/brands/${brand}/triggers`, {
    name: "Dirty Bird cover", placement: { x: -0.048, y: -0.027, s: 1.14 },
    target: { name: "dirty-bird", luminanceKey: `${brand}/targets/db_lum.jpg`, json: { type: "PLANAR", name: "dirty-bird", imagePath: "image-targets/x.jpg", properties: { width: 768, height: 1024 } } }
  })).body.item;
  const a = (await call(f, "POST", `/ar/brands/${brand}/actions`, { type: "video", name: "Dirty Bird clip", videoKey: `${brand}/video/clip.mp4`, fit: "crop" })).body.item;
  const r = (await call(f, "POST", `/ar/brands/${brand}/rules`, { triggerId: t.id, actionIds: [a.id] })).body.item;
  const s = (await call(f, "POST", `/ar/brands/${brand}/sets`, { name: "Dirty Bird", slug: "dirty-bird", triggerIds: [t.id] })).body.item;
  return { t, a, r, s };
}

test("every route needs the connect key", async () => {
  const f = fakes();
  for (const headers of [{}, { "x-elettro-connect-key": "wrong" }]) {
    assert.equal((await call(f, "GET", "/ar/health", undefined, headers)).status, 401);
    assert.equal((await call(f, "GET", "/ar/brands/stashbox", undefined, headers)).status, 401);
    assert.equal((await call(f, "PUT", "/ar/brands/stashbox/entitlement", { arEnabled: true }, headers)).status, 401);
  }
  assert.equal((await call(f, "GET", "/ar/health")).status, 200);
  // no configured secret: nothing passes, not even an empty key
  assert.equal(gate({ headers: {} }, (s) => s, ""), 401);
  assert.equal(gate({ headers: { "x-elettro-connect-key": "" } }, (s) => s, ""), 401);
});

test("a brand is off by default and writes are refused until it is enabled", async () => {
  const f = fakes();
  const g = await call(f, "GET", "/ar/brands/stashbox");
  assert.equal(g.body.entitlement.arEnabled, false);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/actions", { type: "link", name: "x", label: "Buy", url: "https://stashbox.ai" })).status, 403);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/uploads", { kind: "video", contentType: "video/mp4" })).status, 403);
  assert.equal((await enable(f)).status, 200);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/actions", { type: "link", name: "x", label: "Buy", url: "https://stashbox.ai" })).status, 201);
});

test("brand and set slugs are validated and reserved names refused", async () => {
  const f = fakes();
  assert.equal((await call(f, "GET", "/ar/brands/Bad_Slug")).status, 400);
  assert.equal((await call(f, "GET", "/ar/brands/viewer")).status, 400);
  await enable(f);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/sets", { name: "x", slug: "api", triggerIds: [] })).status, 400);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/sets", { name: "x", slug: "ok-slug", triggerIds: [] })).status, 201);
});

test("enabling and disabling rewrites the brand manifest (disabled = stub)", async () => {
  const f = fakes();
  await enable(f);
  assert.equal(f.written.get("stashbox/manifest.json").enabled, true);
  await call(f, "PUT", "/ar/brands/stashbox/entitlement", { arEnabled: false });
  const m = f.written.get("stashbox/manifest.json");
  assert.equal(m.enabled, false);
  assert.equal(m.qrs, undefined);
  assert.ok(f.invalidated.includes("/stashbox/manifest.json"));
});

test("publishing a ready set writes a manifest with placement, media urls and actions", async () => {
  const f = fakes();
  const { s } = await readySet(f);
  const r = await call(f, "POST", `/ar/brands/stashbox/sets/${s.id}/publish`);
  assert.equal(r.status, 200);
  assert.equal(r.body.manifestUrl, `${BASE}/stashbox/sets/dirty-bird/manifest.json`);
  const m = f.written.get("stashbox/sets/dirty-bird/manifest.json");
  assert.equal(m.engine, "8thwall");
  assert.equal(m.triggers.length, 1);
  assert.deepEqual(m.triggers[0].placement, { x: -0.048, y: -0.027, s: 1.14 });
  assert.equal(m.triggers[0].target.json.imagePath, `${BASE}/stashbox/targets/db_lum.jpg`);
  assert.deepEqual(m.triggers[0].actions[0], { type: "video", id: m.triggers[0].actions[0].id, name: "Dirty Bird clip", url: `${BASE}/stashbox/video/clip.mp4`, fit: "crop", loop: true, scale: 1 });
  assert.ok(f.invalidated.includes("/stashbox/sets/dirty-bird/manifest.json"));
});

test("publish reports every reason a set is not ready", async () => {
  const f = fakes();
  await enable(f);
  const t = (await call(f, "POST", "/ar/brands/stashbox/triggers", { name: "No target yet" })).body.item;
  const t2 = (await call(f, "POST", "/ar/brands/stashbox/triggers", { name: "Missing files", target: { name: "x", luminanceKey: "stashbox/targets/gone.jpg", json: { a: 1 } } })).body.item;
  const a = (await call(f, "POST", "/ar/brands/stashbox/actions", { type: "video", name: "Ghost video", videoKey: "stashbox/video/ghost.mp4" })).body.item;
  await call(f, "POST", "/ar/brands/stashbox/rules", { triggerId: t2.id, actionIds: [a.id] });
  const s = (await call(f, "POST", "/ar/brands/stashbox/sets", { name: "Bad", slug: "bad", triggerIds: [t.id, t2.id] })).body.item;
  const r = await call(f, "POST", `/ar/brands/stashbox/sets/${s.id}/publish`);
  assert.equal(r.status, 422);
  const text = r.body.problems.join(" | ");
  assert.match(text, /No target yet.*no tracking target/);
  assert.match(text, /Missing files.*tracking image was never uploaded/);
  assert.match(text, /Ghost video.*never uploaded/);
  assert.equal(f.written.has("stashbox/sets/bad/manifest.json"), false);
});

test("an oversized or non-mp4 video blocks publishing", async () => {
  const f = fakes();
  const { s } = await readySet(f);
  f.objects.set("stashbox/video/clip.mp4", { size: 300 * 1024 * 1024, contentType: "video/mp4" });
  assert.match((await call(f, "POST", `/ar/brands/stashbox/sets/${s.id}/publish`)).body.problems.join(), /too large/);
  f.objects.set("stashbox/video/clip.mp4", { size: 1000, contentType: "video/quicktime" });
  assert.match((await call(f, "POST", `/ar/brands/stashbox/sets/${s.id}/publish`)).body.problems.join(), /not an MP4/);
});

test("storage keys must sit under the brand's own folder", async () => {
  const f = fakes();
  await enable(f);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/actions", { type: "video", name: "x", videoKey: "solarmeister/video/a.mp4" })).status, 400);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/actions", { type: "video", name: "x", videoKey: "stashbox/../solarmeister/a.mp4" })).status, 400);
});

test("QR codes: url rules, one main, slugs never reused, changes are logged", async () => {
  const f = fakes();
  const { s } = await readySet(f);
  const post = (b) => call(f, "POST", "/ar/brands/stashbox/qrs", b, { "x-elettro-connect-key": KEY, "x-elettro-actor": "dean@example.test" });
  for (const url of ["http://stashbox.com/radio", "javascript:alert(1)", "data:text/html,hi", "https://user:pw@stashbox.com", "https://" + "a".repeat(2100) + ".com"]) {
    assert.equal((await post({ name: "Bad", slug: "bad", mode: "url", url })).status, 400, url);
  }
  const main = (await post({ name: "Main", slug: "main", mode: "url", url: "https://stashbox.com/radio", isMain: true })).body.item;
  const second = (await post({ name: "Album", slug: "dirty-bird", mode: "scanner", setId: s.id, isMain: true })).body.item;
  const list = (await call(f, "GET", "/ar/brands/stashbox")).body.qrs;
  assert.equal(list.filter((q) => q.isMain).length, 1);
  assert.equal(list.find((q) => q.id === second.id).isMain, true);
  assert.equal((await post({ name: "Dup", slug: "main", mode: "url", url: "https://x.example.test" })).status, 409);
  await call(f, "DELETE", `/ar/brands/stashbox/qrs/${main.id}`);
  assert.equal((await post({ name: "Reuse", slug: "main", mode: "url", url: "https://x.example.test" })).status, 409);
  const logs = [...f.rows].filter(([k]) => k.includes("|QRLOG#"));
  assert.ok(logs.length >= 2);
  assert.equal(logs[0][1].by, "dean@example.test");
  const bm = f.written.get("stashbox/manifest.json");
  assert.equal(bm.main, "dirty-bird");
  assert.equal(bm.qrs["dirty-bird"].manifest, `${BASE}/stashbox/sets/dirty-bird/manifest.json`);
});

test("redirecting a QR changes the brand manifest without touching the QR slug", async () => {
  const f = fakes();
  const { s } = await readySet(f);
  const q = (await call(f, "POST", "/ar/brands/stashbox/qrs", { name: "Main", slug: "main", mode: "url", url: "https://stashbox.com/radio", isMain: true })).body.item;
  assert.deepEqual(f.written.get("stashbox/manifest.json").qrs.main, { mode: "url", url: "https://stashbox.com/radio" });
  const p = await call(f, "PATCH", `/ar/brands/stashbox/qrs/${q.id}`, { mode: "scanner", setId: s.id, slug: "something-else" });
  assert.equal(p.status, 200);
  assert.equal(p.body.item.slug, "main");
  assert.equal(f.written.get("stashbox/manifest.json").qrs.main.mode, "scanner");
});

test("references are checked and in-use items are protected", async () => {
  const f = fakes();
  const { t, a, s } = await readySet(f);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/rules", { triggerId: "nope", actionIds: [a.id] })).status, 400);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/qrs", { name: "q", slug: "q", mode: "scanner", setId: "nope" })).status, 400);
  assert.equal((await call(f, "DELETE", `/ar/brands/stashbox/actions/${a.id}`)).status, 409);
  await call(f, "POST", "/ar/brands/stashbox/qrs", { name: "q", slug: "q", mode: "scanner", setId: s.id });
  assert.equal((await call(f, "DELETE", `/ar/brands/stashbox/sets/${s.id}`)).status, 409);
  // deleting a trigger removes its rules and drops it from sets
  assert.equal((await call(f, "DELETE", `/ar/brands/stashbox/triggers/${t.id}`)).status, 200);
  const d = (await call(f, "GET", "/ar/brands/stashbox")).body;
  assert.equal(d.rules.length, 0);
  assert.deepEqual(d.sets[0].triggerIds, []);
});

test("one trigger can fire several actions and many triggers can share one action", async () => {
  const f = fakes();
  const { t, a, s } = await readySet(f);
  const link = (await call(f, "POST", "/ar/brands/stashbox/actions", { type: "link", name: "Listen", label: "Listen", url: "https://stashbox.com/radio/?song=dirty-bird-20a-stashbox" })).body.item;
  await call(f, "POST", "/ar/brands/stashbox/rules", { triggerId: t.id, actionIds: [link.id], order: 1 });
  f.objects.set("stashbox/targets/sf_lum.jpg", { size: 40000, contentType: "image/jpeg" });
  const t2 = (await call(f, "POST", "/ar/brands/stashbox/triggers", { name: "Super Funk", target: { name: "super-funk", luminanceKey: "stashbox/targets/sf_lum.jpg", json: { name: "super-funk" } } })).body.item;
  await call(f, "POST", "/ar/brands/stashbox/rules", { triggerId: t2.id, actionIds: [a.id] });
  await call(f, "PATCH", `/ar/brands/stashbox/sets/${s.id}`, { triggerIds: [t.id, t2.id] });
  assert.equal((await call(f, "POST", `/ar/brands/stashbox/sets/${s.id}/publish`)).status, 200);
  const m = f.written.get("stashbox/sets/dirty-bird/manifest.json");
  assert.deepEqual(m.triggers[0].actions.map((x) => x.type), ["video", "link"]);
  assert.equal(m.triggers[1].actions[0].id, m.triggers[0].actions[0].id);
});

test("upload links only allow known types and stay in the brand folder", async () => {
  const f = fakes();
  await enable(f);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/uploads", { kind: "video", contentType: "video/quicktime" })).status, 400);
  assert.equal((await call(f, "POST", "/ar/brands/stashbox/uploads", { kind: "exe", contentType: "video/mp4" })).status, 400);
  const r = await call(f, "POST", "/ar/brands/stashbox/uploads", { kind: "video", contentType: "video/mp4" });
  assert.equal(r.status, 200);
  assert.match(r.body.key, /^stashbox\/video\/[0-9a-f]{16}\.mp4$/);
  assert.equal(r.body.publicUrl, `${BASE}/${r.body.key}`);
  assert.equal(r.body.maxBytes, v.LIMITS.videoBytes);
});

test("validation helpers", () => {
  assert.equal(v.httpsUrl("https://stashbox.com/radio/?song=a"), "https://stashbox.com/radio/?song=a");
  assert.throws(() => v.httpsUrl("ftp://x.com"), /https/);
  assert.deepEqual(v.placement({ x: -0.053, y: -0.027, s: 1.13 }), { x: -0.053, y: -0.027, s: 1.13 });
  assert.deepEqual(v.placement(undefined), { x: 0, y: 0, s: 1 });
  assert.throws(() => v.placement({ s: 9 }), /between/);
  assert.throws(() => v.action({ type: "model3d", name: "x" }), /action type/);
  assert.throws(() => v.set({ name: "big", slug: "big", triggerIds: Array.from({ length: 51 }, (_, i) => String(i)) }), /at most 50/);
});

test("manifest builders: stub, brand index and missing pieces", () => {
  assert.equal(stubManifest("stashbox").enabled, false);
  assert.equal(buildBrandManifest({ brand: "b", enabled: false, qrs: [], sets: [], actions: [], baseUrl: BASE }).enabled, false);
  const { problems } = buildSetManifest({ brand: "b", set: { slug: "s", name: "S", triggerIds: [] }, triggers: [], rules: [], actions: [], baseUrl: BASE });
  assert.deepEqual(problems, ["the set has no triggers"]);
  const idx = buildBrandManifest({ brand: "b", enabled: true, qrs: [{ slug: "x", mode: "scanner", setId: "gone" }], sets: [], actions: [], baseUrl: BASE });
  assert.deepEqual(idx.qrs, {}); // a QR pointing at a deleted set is left out instead of breaking the page
});

test("card, gallery and model actions validate and reach the public manifest", async () => {
  const f = fakes();
  await enable(f);
  const post = (body) => call(f, "POST", "/ar/brands/stashbox/actions", body);
  const card = await post({ type: "card", name: "Shop", title: "Get the merch", items: [
    { kind: "product", label: "Super Funk tee", url: "https://stashbox.ai/products/tee", price: "$32", cta: "Buy now", imageKey: "stashbox/img/tee.jpg" },
    { kind: "link", label: "Tour dates", url: "https://stashbox.com" } ] });
  assert.equal(card.status, 201);
  assert.equal((await post({ type: "card", name: "Empty", title: "x", items: [] })).status, 400);
  assert.equal((await post({ type: "card", name: "Bad", title: "x", items: [{ label: "y", url: "http://insecure.test" }] })).status, 400);
  const gal = await post({ type: "gallery", name: "Photos", imageKeys: ["stashbox/img/a.jpg", "stashbox/img/b.jpg"], seconds: 3 });
  assert.equal(gal.status, 201);
  assert.equal((await post({ type: "gallery", name: "Out", imageKeys: ["solarmeister/img/a.jpg"] })).status, 400);
  const mdl = await post({ type: "model", name: "Vinyl", builtin: "vinyl" });
  assert.equal(mdl.status, 201);
  assert.equal((await post({ type: "model", name: "Nope", builtin: "dragon" })).status, 400);
  assert.equal((await post({ type: "model", name: "Panel", builtin: "solarpanel" })).status, 201);
  const form = { type: "form", name: "Preis", title: "Strompreis berechnen", toggle: { options: ["Privatkunde", "Gewerbekunde"] }, fields: [{ label: "PLZ", placeholder: "12345" }, { label: "Verbrauch", suffix: "kWh/Jahr", mode: "numeric" }], cta: "Preis berechnen", accent: "#43b02a" };
  assert.equal((await post(form)).status, 201);
  assert.equal((await post({ ...form, fields: [] })).status, 400); // a form needs fields
  assert.equal((await post({ ...form, accent: "green" })).status, 400);
  assert.equal((await post({ ...form, toggle: { options: ["nur eins"] } })).status, 400);
  const calc = { type: "calculator", name: "Rechner", title: "Was spart mein Balkonkraftwerk?", systems: [{ label: "Max 1000", kwp: 1, selfUse: 0.85, price: 1379, url: "https://shop.test/p" }], accent: "#3fb62c" };
  assert.equal((await post(calc)).status, 201);
  assert.equal((await post({ ...calc, systems: [] })).status, 400);
  assert.equal((await post({ ...calc, kwh: { min: 5000, max: 1000 } })).status, 400);
  const scr = { type: "scratch", name: "Rubbeln", title: "Rubbel dein Geschenk frei", prize: "5 % Rabatt", code: "BEISPIEL5", cta: { label: "Zum Shop", url: "https://shop.test" } };
  assert.equal((await post(scr)).status, 201);
  assert.equal((await post({ ...scr, prize: "" })).status, 400);
  assert.equal((await post({ ...scr, cta: { label: "x", url: "http://insecure.test" } })).status, 400);
  const callCard = await post({ type: "card", name: "Kontakt", title: "Kontakt", items: [{ kind: "link", label: "Anrufen", url: "tel:+49 1525 972 5120" }, { kind: "link", label: "E-Mail", url: "mailto:support@solarmeister-shop.de" }] });
  assert.equal(callCard.status, 201);
  assert.equal((await post({ type: "card", name: "Bad", title: "Bad", items: [{ kind: "link", label: "x", url: "javascript:alert(1)" }] })).status, 400);

  const set = { id: "s", slug: "demo", name: "Demo", triggerIds: ["t"] };
  const trigger = { id: "t", name: "Cover", target: { name: "c", json: { type: "PLANAR" }, luminanceKey: "stashbox/targets/c.jpg" }, placement: { x: 0, y: 0, s: 1 } };
  const actions = [card.body.item, gal.body.item, mdl.body.item];
  const { manifest, problems } = buildSetManifest({ brand: "stashbox", set, triggers: [trigger], rules: [{ triggerId: "t", order: 0, actionIds: actions.map((a) => a.id) }], actions, baseUrl: BASE });
  assert.deepEqual(problems, []);
  const [c, g, m] = manifest.triggers[0].actions;
  assert.equal(c.items[0].image, `${BASE}/stashbox/img/tee.jpg`);
  assert.equal(c.items[0].price, "$32");
  assert.deepEqual(g.images, [`${BASE}/stashbox/img/a.jpg`, `${BASE}/stashbox/img/b.jpg`]);
  assert.equal(m.builtin, "vinyl");
});

test("public scan counter: records scans and taps for real markers only, reads without a key, counts only", async () => {
  const f = fakes();
  f.written.set("stashbox/manifest.json", { v: 1, brand: "stashbox", enabled: true, qrs: { covers: { mode: "scanner", set: "demo" } } });
  f.written.set("stashbox/sets/demo/manifest.json", { triggers: [{ id: "super-funk", name: "Super Funk", target: { json: { imagePath: "https://x.test/sf.jpg" } } }, { id: "dirty-bird", name: "Dirty Bird" }, { id: "never-scanned", name: "Never Scanned" }] });
  f.written.set("domains.json", { _scan: ["stashbox/covers"] });
  const none = {}; // no connect key on purpose: these two routes are public
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "super-funk", kind: "scan" }, none)).status, 204);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "super-funk", kind: "scan" }, none)).status, 204);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "dirty-bird", kind: "scan" }, none)).status, 204);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "super-funk", kind: "tap" }, none)).status, 204);
  // refused: a marker that does not exist, a brand with no manifest, a bad kind, junk ids, a body that is too big
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "nope", kind: "scan" }, none)).status, 404);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "ghost", trigger: "x", kind: "scan" }, none)).status, 404);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "super-funk", kind: "like" }, none)).status, 400);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "../x", trigger: "super-funk", kind: "scan" }, none)).status, 400);
  assert.equal((await call(f, "POST", "/ar/event", { brand: "stashbox", trigger: "super-funk", kind: "scan", pad: "x".repeat(700) }, none)).status, 413);

  const s = await call(f, "GET", "/ar/stats", undefined, none);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.total, { scans: 3, taps: 1 });
  assert.deepEqual(s.body.today, { scans: 3, taps: 1 });
  assert.equal(s.body.days.length, 30);
  assert.deepEqual(s.body.brands, [{ brand: "stashbox", scans: 3, taps: 1 }]);
  assert.deepEqual(s.body.markers.map((x) => [x.id, x.name, x.scans, x.taps]), [["super-funk", "Super Funk", 2, 1], ["dirty-bird", "Dirty Bird", 1, 0], ["never-scanned", "Never Scanned", 0, 0]]); // unscanned markers are listed too
  assert.equal(s.body.markers[0].thumb, "https://x.test/sf.jpg");
  assert.equal(s.body.lastScan.id, "dirty-bird");
  assert.ok(s.body.since);
  // the stats carry nothing about people: only these keys
  assert.deepEqual(Object.keys(s.body).sort(), ["brands", "days", "lastScan", "markers", "ok", "since", "today", "total", "updatedAt"]);
  // everything else still needs the connect key
  assert.equal((await call(f, "GET", "/ar/brands/stashbox", undefined, none)).status, 401);
  assert.equal((await call(f, "GET", "/ar/health", undefined, none)).status, 401);
});
