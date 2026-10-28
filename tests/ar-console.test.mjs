import test from "node:test";
import assert from "node:assert/strict";
import { arBrandsFor, canToggleAr, experienceCards, mainQr, pickBrand, publicUrl, qualityBars, qrAddress, qrDestination, qrFields } from "../apps/web/lib/ar-access.ts";

const ALL = ["solarmeister", "stashbox", "neckermann-strom", "elettro"];
const OWNER = { owner: true, brands: [] };
const CLIENT = { owner: false, brands: ["solarmeister", "neckermann-strom"] };

test("the owner sees every brand so AR can be switched on", () => {
  assert.deepEqual(arBrandsFor(OWNER, ALL, {}), ALL);
});

test("a client sees only their own brands that have AR enabled", () => {
  assert.deepEqual(arBrandsFor(CLIENT, ALL, { solarmeister: true, stashbox: true, "neckermann-strom": false }), ["solarmeister"]);
  assert.deepEqual(arBrandsFor(CLIENT, ALL, {}), []);
  assert.deepEqual(arBrandsFor(null, ALL, { stashbox: true }), []);
});

test("only the owner can switch AR on or off", () => {
  assert.equal(canToggleAr(OWNER), true);
  assert.equal(canToggleAr(CLIENT), false);
  assert.equal(canToggleAr(null), false);
});

test("pickBrand honours ?brand= only for visible brands", () => {
  assert.equal(pickBrand("solarmeister", ["solarmeister", "stashbox"]), "solarmeister");
  assert.equal(pickBrand("elettro", ["solarmeister", "stashbox"]), "stashbox");
  assert.equal(pickBrand(undefined, ["solarmeister", "neckermann-strom"]), "solarmeister");
  assert.equal(pickBrand("x", []), "");
});

test("quality bars map 0-100 onto 0-4", () => {
  assert.deepEqual([undefined, 0, 10, 30, 60, 90].map(qualityBars), [0, 0, 1, 2, 3, 4]);
});

test("publicUrl joins the CDN base and key, and skips a missing key", () => {
  assert.equal(publicUrl("https://ar.elettro.com/", "stashbox/targets/a.jpg"), "https://ar.elettro.com/stashbox/targets/a.jpg");
  assert.equal(publicUrl("https://ar.elettro.com", undefined), null);
});

const DOC = {
  triggers: [
    { id: "t1", name: "Dirty Bird", status: "live", quality: 80, target: { luminanceKey: "stashbox/targets/db.jpg" } },
    { id: "t2", name: "I'm Waiting", status: "draft", imageKey: "stashbox/images/iw.jpg" }
  ],
  actions: [
    { id: "a1", name: "Dirty Bird video", type: "video" },
    { id: "a2", name: "Listen link", type: "link", label: "Listen" }
  ],
  rules: [
    { triggerId: "t1", actionIds: ["a2"], order: 2 },
    { triggerId: "t1", actionIds: ["a1"], order: 1 }
  ],
  sets: [{ id: "s1", name: "Covers", slug: "covers", triggerIds: ["t1", "t2"] }],
  qrs: [{ id: "q1", name: "Covers", slug: "covers", mode: "scanner" }, { id: "q2", name: "Main", slug: "main", mode: "url", url: "https://stashbox.com/radio" }]
};

test("cards list actions in rule order, flag covers with no action, and show sets", () => {
  const [a, b] = experienceCards(DOC, "https://ar.elettro.com");
  assert.equal(a.summary, "Video + Listen");
  assert.equal(a.live, true);
  assert.equal(a.qualityBars, 4);
  assert.equal(a.thumbUrl, "https://ar.elettro.com/stashbox/targets/db.jpg");
  assert.deepEqual(a.sets, ["Covers"]);
  assert.equal(b.hasActions, false);
  assert.equal(b.summary, "No action attached");
  assert.equal(b.live, false);
  assert.equal(b.thumbUrl, "https://ar.elettro.com/stashbox/images/iw.jpg");
});

test("an empty or missing brand document gives no cards and no main code", () => {
  assert.deepEqual(experienceCards({}, "https://ar.elettro.com"), []);
  assert.equal(mainQr({}), null);
});

test("the main code is the one marked main, else slug main", () => {
  assert.equal(mainQr(DOC).id, "q2");
  assert.equal(mainQr({ qrs: [{ id: "x", name: "A", slug: "a", mode: "scanner", isMain: true }, ...DOC.qrs] }).id, "x");
});

test("the main code answers at the bare brand address, others at /<brand>/<slug>", () => {
  assert.equal(qrAddress("https://ar.elettro.com/", "stashbox", { slug: "main", isMain: true }), "https://ar.elettro.com/stashbox");
  assert.equal(qrAddress("https://ar.elettro.com", "stashbox", { slug: "covers" }), "https://ar.elettro.com/stashbox/covers");
});

test("destinations read in words and tolerate missing references", () => {
  const sets = [{ id: "s1", name: "Covers", slug: "covers" }];
  const actions = [{ id: "a1", name: "Dirty Bird video", type: "video" }];
  assert.equal(qrDestination({ id: "1", name: "a", slug: "a", mode: "url", url: "https://stashbox.com/radio" }, sets, actions), "https://stashbox.com/radio");
  assert.equal(qrDestination({ id: "1", name: "a", slug: "a", mode: "scanner", setId: "s1" }, sets, actions), "Set “Covers”");
  assert.equal(qrDestination({ id: "1", name: "a", slug: "a", mode: "scanner", setId: "gone" }, sets, actions), "Set “missing set”");
  assert.equal(qrDestination({ id: "1", name: "a", slug: "a", mode: "experience", actionId: "a1" }, sets, actions), "Dirty Bird video");
});

test("qrFields passes only the QR fields and drops everything else", () => {
  assert.deepEqual(qrFields({ brand: "stashbox", mode: "url", url: "https://x.com", isMain: true, evil: "x", name: 5, setId: "s1" }), { mode: "url", url: "https://x.com", isMain: true, setId: "s1" });
  assert.deepEqual(qrFields(null), {});
  assert.deepEqual(qrFields("text"), {});
});
