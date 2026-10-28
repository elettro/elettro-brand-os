import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// The Lambda has its own pinned sharp; load that exact copy (two native copies in one process clash).
const sharp = createRequire(new URL("../services/ar-lambda/compile.mjs", import.meta.url))("sharp");
import { compileTarget, defaultCrop, cropProblems } from "../services/ar-lambda/compile.mjs";
import { createApp } from "../services/ar-lambda/app.mjs";

// A busy picture (random noise) so the tracking image is not flat, in any size and format.
const picture = (width, height, format = "png") =>
  sharp(Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 2654435761) % 251)), { raw: { width, height, channels: 3 } })[format]().toBuffer();

test("defaultCrop is the centered 3:4 portrait region (same as the 8th Wall CLI)", () => {
  assert.deepEqual(defaultCrop(1024, 1024), { left: 128, top: 0, width: 768, height: 1024 });
  assert.deepEqual(defaultCrop(1000, 2000), { left: 0, top: 334, width: 1000, height: 1333 });
  assert.deepEqual(defaultCrop(1920, 1080), { left: 555, top: 0, width: 810, height: 1080 });
});

test("cropProblems names each way a crop can be wrong", () => {
  assert.deepEqual(cropProblems({ left: 0, top: 0, width: 768, height: 1024 }, 1024, 1024), []);
  assert.match(cropProblems({ left: -1, top: 0, width: 768, height: 1024 }, 1024, 1024).join(), /outside/);
  assert.match(cropProblems({ left: 0, top: 0, width: 400, height: 1024 }, 1024, 1024).join(), /narrow/);
  assert.match(cropProblems({ left: 0, top: 0, width: 768, height: 500 }, 1024, 1024).join(), /short/);
  assert.match(cropProblems({ left: 500, top: 0, width: 768, height: 1024 }, 1024, 1024).join(), /edge/);
  assert.match(cropProblems({ left: NaN, top: 0, width: 768, height: 1024 }, 1024, 1024).join(), /whole numbers/);
});

test("compileTarget makes the same files and JSON shape the live targets have", async () => {
  const out = await compileTarget({ buffer: await picture(1024, 1024), name: "dirty-bird-abc123" });
  assert.deepEqual(out.crop, { left: 128, top: 0, width: 768, height: 1024 });
  const lum = await sharp(out.files.luminance).metadata();
  const thumb = await sharp(out.files.thumbnail).metadata();
  const cropped = await sharp(out.files.cropped).metadata();
  assert.equal(lum.format, "jpeg");
  assert.equal(lum.height, 640);
  const { data } = await sharp(out.files.luminance).raw().toBuffer({ resolveWithObject: true });
  const px = Array.from({ length: 300 }, (_, i) => i * 3 * 97 % (data.length - 3));
  assert.ok(px.every((p) => Math.abs(data[p] - data[p + 1]) <= 2 && Math.abs(data[p + 1] - data[p + 2]) <= 2), "luminance image is gray");
  assert.equal(lum.width, 480); // 768 x 1024 scaled to 640 tall
  assert.equal(thumb.height, 350);
  assert.deepEqual([cropped.width, cropped.height], [768, 1024]);
  assert.equal(out.json.type, "PLANAR");
  assert.equal(out.json.name, "dirty-bird-abc123");
  assert.deepEqual(out.json.properties, { left: 128, top: 0, width: 768, height: 1024, isRotated: false, originalWidth: 1024, originalHeight: 1024 });
  assert.deepEqual(Object.keys(out.json.resources).sort(), ["croppedImage", "luminanceImage", "originalImage", "thumbnailImage"]);
  assert.equal(out.json.imagePath, "image-targets/dirty-bird-abc123_luminance.jpg");
});

test("compileTarget accepts a JPEG and honours a custom crop", async () => {
  const out = await compileTarget({ buffer: await picture(1600, 1200, "jpeg"), name: "x", crop: { left: 0, top: 0, width: 900, height: 1200 } });
  assert.deepEqual(out.crop, { left: 0, top: 0, width: 900, height: 1200 });
  assert.equal(out.source.format, "jpeg");
});

test("compileTarget refuses non-JPEG/PNG, tiny images, bad crops and non-images", async () => {
  await assert.rejects(compileTarget({ buffer: await picture(1024, 1024, "webp"), name: "x" }), /JPEG or PNG/);
  await assert.rejects(compileTarget({ buffer: await picture(300, 300), name: "x" }), /too small/);
  await assert.rejects(compileTarget({ buffer: await picture(1024, 1024), name: "x", crop: { left: 0, top: 0, width: 2000, height: 1024 } }), /edge/);
  await assert.rejects(compileTarget({ buffer: Buffer.from("not an image"), name: "x" }), /not a readable image/);
});

test("compileTarget turns a phone photo upright using its EXIF orientation", async () => {
  // 1200 wide x 900 tall stored sideways with orientation 6 means the real picture is 900 x 1200.
  const sideways = await sharp(await picture(1200, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const out = await compileTarget({ buffer: sideways, name: "x" });
  assert.deepEqual(out.crop, { left: 0, top: 0, width: 900, height: 1200 });
});

// ---- the API route, with in-memory stand-ins for DynamoDB and S3 ----
const KEY = "k";
function api() {
  const rows = new Map(), objects = new Map(), written = new Map();
  const store = {
    async list(b) { return [...rows].filter(([k]) => k.startsWith(`${b}|`)).map(([k, i]) => ({ ...i, PK: `BRAND#${b}`, SK: k.split("|")[1] })); },
    async get(b, sk) { return rows.get(`${b}|${sk}`) || null; },
    async put(b, sk, d) { rows.set(`${b}|${sk}`, structuredClone(d)); },
    async del(b, sk) { rows.delete(`${b}|${sk}`); },
    async add() {}
  };
  const files = {
    async presignPut() { return { url: "https://s3.test/x" }; },
    async head(key) { const o = objects.get(key); return o ? { size: o.buf.length, contentType: o.type } : null; },
    async getBuffer(key) { return objects.get(key).buf; },
    async putBuffer(key, buf, type) { objects.set(key, { buf, type }); },
    async putJson(key, obj) { written.set(key, obj); },
    async getJson(key) { return written.get(key) ?? null; }
  };
  const app = createApp({ store, files, cdn: { async invalidate() {} }, config: { publicBaseUrl: "https://ar.test", apiKey: KEY } });
  const call = async (method, path, body) => {
    const r = await app.handle({ rawPath: path, headers: { "x-elettro-connect-key": KEY }, requestContext: { http: { method, path } }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return { call, objects, rows };
}

test("POST triggers/compile stores the tracking files and creates a draft trigger that can be published", async () => {
  const a = api();
  await a.call("PUT", "/ar/brands/stashbox/entitlement", { arEnabled: true });
  a.objects.set("stashbox/images/cover1.png", { buf: await picture(1024, 1024), type: "image/png" });
  const res = await a.call("POST", "/ar/brands/stashbox/triggers/compile", { name: "Super Funk", imageKey: "stashbox/images/cover1.png" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const t = res.body.item;
  assert.equal(t.status, "draft");
  assert.equal(t.name, "Super Funk");
  assert.match(t.target.name, /^super-funk-[0-9a-f]{6}$/);
  assert.equal(t.target.luminanceKey, `stashbox/targets/${t.target.name}_luminance.jpg`);
  assert.ok(a.objects.has(t.target.luminanceKey));
  assert.ok(a.objects.has(`stashbox/targets/${t.target.name}_thumbnail.jpg`));
  assert.equal(a.objects.get(t.target.luminanceKey).type, "image/jpeg");
  // a set holding it builds a manifest with the target (the only thing missing to publish is an action)
  const set = (await a.call("POST", "/ar/brands/stashbox/sets", { name: "Covers", slug: "covers", triggerIds: [t.id] })).body.item;
  const pub = await a.call("POST", `/ar/brands/stashbox/sets/${set.id}/publish`);
  assert.equal(pub.status, 422);
  assert.ok(pub.body.problems.every((p) => !/tracking image was never uploaded/.test(p)), JSON.stringify(pub.body.problems));
});

test("POST triggers/compile checks brand, upload, size of crop and AR being on", async () => {
  const a = api();
  const post = (body, brand = "stashbox") => a.call("POST", `/ar/brands/${brand}/triggers/compile`, body);
  assert.equal((await post({ name: "A", imageKey: "stashbox/images/a.png" })).status, 403); // AR off
  await a.call("PUT", "/ar/brands/stashbox/entitlement", { arEnabled: true });
  assert.equal((await post({ imageKey: "stashbox/images/a.png" })).status, 400); // no name
  assert.equal((await post({ name: "A" })).status, 400); // no image
  assert.equal((await post({ name: "A", imageKey: "other/images/a.png" })).status, 400); // someone else's folder
  assert.equal((await post({ name: "A", imageKey: "stashbox/images/a.png" })).status, 404); // never uploaded
  a.objects.set("stashbox/images/a.png", { buf: await picture(1024, 1024), type: "image/png" });
  const bad = await post({ name: "A", imageKey: "stashbox/images/a.png", crop: { left: 0, top: 0, width: 5000, height: 1024 } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /edge/);
  assert.equal([...a.rows.keys()].filter((k) => k.includes("TRIGGER#")).length, 0); // nothing half-created
});
