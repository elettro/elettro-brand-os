import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { executeArAction } from "../apps/web/lib/ar-gateway-core.ts";
import { createApp } from "../services/ar-lambda/app.mjs";

// The chat tools (ar-gateway-core) driving the real AR API code (app.mjs + compile.mjs with real sharp),
// with in-memory DynamoDB / S3 stand-ins: cover -> actions -> set -> publish -> QR, exactly as a chat session would.
// Runs once the AR Lambda has the cover compiler (the compile PR); skipped until then.
const hasCompiler = existsSync(new URL("../services/ar-lambda/compile.mjs", import.meta.url));
const sharp = hasCompiler ? createRequire(new URL("../services/ar-lambda/compile.mjs", import.meta.url))("sharp") : null;
const BASE = "https://ar.test";
const KEY = "k";

function system() {
  const rows = new Map(), objects = new Map(), written = new Map();
  const store = {
    async list(b) { return [...rows].filter(([k]) => k.startsWith(`${b}|`)).map(([k, i]) => ({ ...i, PK: `BRAND#${b}`, SK: k.split("|")[1] })); },
    async get(b, sk) { return rows.get(`${b}|${sk}`) || null; },
    async put(b, sk, d) { rows.set(`${b}|${sk}`, structuredClone(d)); },
    async del(b, sk) { rows.delete(`${b}|${sk}`); },
    async add() {}
  };
  const files = {
    async presignPut({ key }) { return { url: `https://s3.test/${key}` }; },
    async head(key) { const o = objects.get(key); return o ? { size: o.buf.length, contentType: o.type } : null; },
    async getBuffer(key) { return objects.get(key).buf; },
    async putBuffer(key, buf, type) { objects.set(key, { buf, type }); },
    async putJson(key, obj) { written.set(key, structuredClone(obj)); },
    async getJson(key) { return written.has(key) ? structuredClone(written.get(key)) : null; }
  };
  const app = createApp({ store, files, cdn: { async invalidate() {} }, config: { publicBaseUrl: BASE, apiKey: KEY } });
  const api = async (method, path, body) => {
    const r = await app.handle({ rawPath: path, headers: { "x-elettro-connect-key": KEY }, requestContext: { http: { method, path } }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = r.body ? JSON.parse(r.body) : {};
    if (r.statusCode >= 400 || data.ok === false) throw Object.assign(new Error(data.error || `status ${r.statusCode}`), { status: r.statusCode, problems: data.problems });
    return data;
  };
  const deps = {
    brands: ["stashbox"],
    publicBase: BASE,
    call: (path, init = {}) => api(init.method || "GET", path, init.body),
    allowedFileHost: (u) => u.hostname === "files.oaiusercontent.com",
    async fetchFile() { return sharp(Buffer.from(Array.from({ length: 1254 * 1254 * 3 }, (_, i) => (i * 2654435761) % 251)), { raw: { width: 1254, height: 1254, channels: 3 } }).png().toBuffer(); },
    async putFile(url, headers, bytes) { objects.set(new URL(url).pathname.slice(1), { buf: Buffer.from(bytes), type: headers["content-type"] }); }
  };
  const run = (action, cmd) => executeArAction(action, { brandSlug: "stashbox", confirmed: true, ...cmd }, deps);
  return { run, api, rows, objects, written, deps };
}

test("a whole chat session: cover -> video + link -> connect -> set -> publish -> QR", { skip: !hasCompiler }, async () => {
  const s = system();
  await s.api("PUT", "/ar/brands/stashbox/entitlement", { arEnabled: true });

  // 1. the cover arrives as a ChatGPT attachment; the compiler makes it scannable
  const cover = await s.run("ar_add_cover", { name: "Super Funk", file: { download_url: "https://files.oaiusercontent.com/f/1", file_id: "f1" } });
  assert.equal(cover.draft, true);
  assert.equal(cover.source.format, "png");
  assert.deepEqual(cover.trackedRegion, { left: 157, top: 0, width: 941, height: 1254 });
  const coverId = cover.cover.id;

  // 2. a video through the upload link, then the video action and a Listen button
  const up = await s.run("ar_prepare_upload", { kind: "video" });
  await s.deps.putFile(up.uploadUrl, up.headers, new Uint8Array(2048));
  const video = await s.run("ar_add_action", { type: "video", name: "Super Funk clip", videoKey: up.key });
  const listen = await s.run("ar_add_action", { type: "link", name: "Listen", url: "https://stashbox.com/radio" });

  // 3. what happens on scan, in order; then the set
  await s.run("ar_connect", { triggerId: coverId, actionIds: [video.action.id, listen.action.id] });
  const set = await s.run("ar_add_to_set", { setName: "Covers", triggerIds: [coverId] });
  assert.equal(set.created, true);

  // 4. nothing is public yet, and the overview says the cover is a scannable draft
  let overview = await s.run("ar_overview", {});
  assert.equal(overview.covers[0].scannable, true);
  assert.equal(overview.covers[0].status, "draft");
  assert.deepEqual(overview.covers[0].actions.map((a) => a.name), ["Super Funk clip", "Listen"]);
  assert.equal(s.written.has("stashbox/sets/covers/manifest.json"), false);

  // 5. publish (a button in the OS; the core action is what that button's route calls)
  const pub = await s.run("ar_publish_set", { setId: set.set.id });
  assert.equal(pub.published, true);
  const manifest = s.written.get("stashbox/sets/covers/manifest.json");
  assert.equal(manifest.triggers.length, 1);
  const t = manifest.triggers[0];
  assert.match(t.target.json.imagePath, new RegExp(`^${BASE}/stashbox/targets/super-funk-[0-9a-f]{6}_luminance\\.jpg$`));
  assert.equal(t.target.json.type, "PLANAR");
  assert.equal(t.actions[0].type, "video");
  assert.equal(t.actions[0].url, `${BASE}/${up.key}`);
  assert.equal(t.actions[1].url, "https://stashbox.com/radio");
  overview = await s.run("ar_overview", {});
  assert.equal(overview.covers[0].status, "live");

  // 6. a printed code that opens the set; the brand manifest routes it to the set's manifest
  const qr = await s.run("ar_set_qr", { name: "Album sleeves", mode: "scanner", setId: set.set.id });
  assert.equal(qr.address, `${BASE}/stashbox/album-sleeves`);
  const index = s.written.get("stashbox/manifest.json");
  assert.equal(index.qrs["album-sleeves"].mode, "scanner");
  assert.equal(index.qrs["album-sleeves"].manifest, `${BASE}/stashbox/sets/covers/manifest.json`);
});

test("publishing too early explains what is missing and leaves the cover a draft", { skip: !hasCompiler }, async () => {
  const s = system();
  await s.api("PUT", "/ar/brands/stashbox/entitlement", { arEnabled: true });
  const cover = await s.run("ar_add_cover", { name: "No action yet", file: { download_url: "https://files.oaiusercontent.com/f/1", file_id: "f1" } });
  const set = await s.run("ar_add_to_set", { setName: "Covers", triggerIds: [cover.cover.id] });
  await assert.rejects(s.run("ar_publish_set", { setId: set.set.id }), (e) => e.status === 422 && /no actions/.test(e.problems.join()));
  assert.equal((await s.run("ar_overview", {})).covers[0].status, "draft");
});
