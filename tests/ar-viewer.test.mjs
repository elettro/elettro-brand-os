import test from "node:test";
import assert from "node:assert/strict";
import { parsePath, resolveRoute, resolveEntry, cropUv, planeFor, pickVideo, linkButtons, withUtm, targetData } from "../apps/ar-viewer/src/logic.js";

test("parsePath reads brand and qr slug", () => {
  assert.deepEqual(parsePath("/stashbox/radio"), { brand: "stashbox", slug: "radio" });
  assert.deepEqual(parsePath("/Stashbox/"), { brand: "stashbox", slug: "" });
  assert.deepEqual(parsePath("/"), { brand: "", slug: "" });
});

test("resolveEntry covers every QR mode and the off states", () => {
  const m = { enabled: true, main: "main", qrs: {
    main: { mode: "url", url: "https://stashbox.com/radio" },
    covers: { mode: "scanner", set: "covers", manifest: "https://ar.elettro.com/stashbox/sets/covers/manifest.json" },
    clip: { mode: "experience", action: { type: "video", url: "x.mp4" } }
  } };
  assert.deepEqual(resolveEntry(m, ""), { kind: "redirect", url: "https://stashbox.com/radio" });
  assert.equal(resolveEntry(m, "covers").kind, "scanner");
  assert.equal(resolveEntry(m, "clip").kind, "experience");
  assert.equal(resolveEntry(m, "nope").kind, "unknown");
  assert.equal(resolveEntry({ enabled: false }, "x").kind, "inactive");
  assert.equal(resolveEntry(null, "x").kind, "inactive");
});

test("cropUv matches the phone-tested 9:16 values", () => {
  const { repeat, offset } = cropUv(9 / 16);
  assert.equal(repeat[0], 1);
  assert.ok(Math.abs(repeat[1] - 0.5625) < 1e-9);
  assert.ok(Math.abs(offset[1] - 0.21875) < 1e-9);
  const wide = cropUv(16 / 9);
  assert.ok(Math.abs(wide.repeat[0] - 0.5625) < 1e-9);
  assert.deepEqual(cropUv(1), { repeat: [1, 1], offset: [0, 0] });
});

test("planeFor sizes each fit mode", () => {
  assert.equal(planeFor("crop", 9 / 16, 1.2).width, 1.2);
  assert.equal(planeFor("fill", 1, 1).repeat[0], 1);
  const f = planeFor("float", 9 / 16, 1);
  assert.ok(Math.abs(f.width - 0.9) < 1e-9 && f.height === 1.6);
});

test("actions: first video drives the overlay, links become buttons with utm", () => {
  const acts = [{ type: "link", label: "Listen", url: "https://stashbox.com/radio/?song=a" }, { type: "video", url: "v.mp4" }, { type: "video", url: "w.mp4" }];
  assert.equal(pickVideo(acts).url, "v.mp4");
  assert.equal(pickVideo([]), null);
  assert.deepEqual(linkButtons(acts), [{ label: "Listen", url: "https://stashbox.com/radio/?song=a&utm_source=ar" }]);
  assert.equal(withUtm("https://x.com/?utm_source=ig"), "https://x.com/?utm_source=ig");
  assert.equal(withUtm("not a url"), "not a url");
});

test("targetData feeds the engine with names", () => {
  const out = targetData([{ target: { name: "super-funk", json: { imagePath: "https://l/x.jpg", type: "PLANAR" } } }]);
  assert.deepEqual(out, [{ imagePath: "https://l/x.jpg", type: "PLANAR", name: "super-funk" }]);
});

import { sortActions, galleryIndex } from "../apps/ar-viewer/src/logic.js";
test("sortActions picks one of each AR kind and keeps every link", () => {
  const s = sortActions([{ type: "link", label: "A", url: "https://a.test" }, { type: "model", builtin: "vinyl" }, { type: "card", title: "t", items: [] }, { type: "link", label: "B", url: "https://b.test" }]);
  assert.equal(s.model.builtin, "vinyl");
  assert.equal(s.card.title, "t");
  assert.equal(s.video, null);
  assert.deepEqual(s.links.map((l) => l.label), ["A", "B"]);
});
test("galleryIndex cycles through the pictures", () => {
  assert.equal(galleryIndex(3, 3, 0), 0);
  assert.equal(galleryIndex(3, 3, 3.1), 1);
  assert.equal(galleryIndex(3, 3, 9), 0);
  assert.equal(galleryIndex(1, 3, 100), 0);
});

test("resolveRoute: shared host, brand-owned host, unknown host", () => {
  const domains = { "ar.elettro.com": { brand: "elettro", shared: true }, "ar.stashbox.com": { brand: "stashbox" } };
  // shared host: bare address is the host's own brand, otherwise /<brand>/<slug>
  assert.deepEqual(resolveRoute("ar.elettro.com", "/", domains), { brand: "elettro", slug: "" });
  assert.deepEqual(resolveRoute("ar.elettro.com", "/stashbox", domains), { brand: "stashbox", slug: "" });
  assert.deepEqual(resolveRoute("ar.elettro.com", "/Stashbox/Covers", domains), { brand: "stashbox", slug: "covers" });
  // brand-owned host: brand from the host, first path part is the QR slug
  assert.deepEqual(resolveRoute("ar.stashbox.com", "/", domains), { brand: "stashbox", slug: "" });
  assert.deepEqual(resolveRoute("ar.stashbox.com", "/covers", domains), { brand: "stashbox", slug: "covers" });
  // unknown host or no domains file: the plain /<brand>/<slug> form, and nothing on a bare path
  assert.deepEqual(resolveRoute("localhost", "/stashbox/radio", {}), { brand: "stashbox", slug: "radio" });
  assert.deepEqual(resolveRoute("localhost", "/", null), { brand: "", slug: "" });
});
