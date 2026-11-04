import test from "node:test";
import assert from "node:assert/strict";
import { buildAssetFeed } from "../services/dev-api-lambda/asset-feed.mjs";

const brands = [{ id: "b1", slug: "stashbox", name: "Stashbox" }, { id: "b2", slug: "elettro", name: "Elettro" }, { id: "lib", slug: "creative-assets", name: "Library" }];
const now = Date.parse("2026-11-04T18:00:00Z");

test("counts images and videos per brand, lists the shared library as the Elettro Stock Gallery", () => {
  const f = buildAssetFeed({ brands, now, added: [], totals: [
    { brandId: "b1", kind: "image", n: 10 }, { brandId: "b1", kind: "carousel", n: 2 }, { brandId: "b1", kind: "video", n: 5 },
    { brandId: "b2", kind: "image", n: 3 }, { brandId: "lib", kind: "image", n: 999 }] });
  assert.deepEqual(f.total, { images: 1014, videos: 5, audio: 0, total: 1019 });
  assert.equal(f.brands.length, 3);
  assert.deepEqual(f.brands[0], { slug: "creative-assets", name: "Elettro Stock Gallery", stock: true, images: 999, videos: 0, audio: 0, total: 999 });
  assert.deepEqual(f.brands[1], { slug: "stashbox", name: "Stashbox", images: 12, videos: 5, audio: 0, total: 17 });
});

test("30 zero-filled days end today; running total ends at the grand total", () => {
  const f = buildAssetFeed({ brands, now,
    totals: [{ brandId: "b1", kind: "image", n: 10 }, { brandId: "b1", kind: "video", n: 5 }],
    added: [{ brandId: "b1", kind: "image", d: "2026-11-04", n: 4 }, { brandId: "b1", kind: "video", d: "2026-11-02", n: 1 }, { brandId: "b1", kind: "image", d: "2026-08-01", n: 6 }] });
  assert.equal(f.days.length, 30);
  assert.equal(f.days[29].d, "2026-11-04");
  assert.equal(f.days[29].images, 4);
  assert.equal(f.days[29].total, 15);
  assert.equal(f.days[27].total, 11); // 10 before the window + 1 video on 11-02
  assert.equal(f.days[0].total, 10);
});

test("google-review demo brand is ignored", () => {
  const f = buildAssetFeed({ brands: [...brands, { id: "gr", slug: "google-review", name: "Google Review" }], now, added: [], totals: [{ brandId: "gr", kind: "video", n: 8 }, { brandId: "b1", kind: "image", n: 1 }] });
  assert.equal(f.total.total, 1);
  assert.equal(f.brands.length, 3); // stashbox, elettro, stock gallery
});

test("audio clips count as their own kind and in the daily total", () => {
  const f = buildAssetFeed({ brands, now, totals: [{ brandId: "lib", kind: "audio", n: 948 }, { brandId: "b1", kind: "image", n: 2 }],
    added: [{ brandId: "lib", kind: "audio", d: "2026-11-04", n: 948 }] });
  assert.equal(f.total.audio, 948);
  assert.equal(f.days[29].audio, 948);
  assert.equal(f.days[29].total, 950);
  assert.equal(f.days[0].total, 2);
});
