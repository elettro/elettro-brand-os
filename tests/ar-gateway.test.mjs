import test from "node:test";
import assert from "node:assert/strict";
import { executeArAction, sniffImage, summarize, ArToolError, AR_ACTIONS } from "../apps/web/lib/ar-gateway-core.ts";
import { MCP_TOOLS, toolsForClient, findAuthorizedTool } from "../apps/web/lib/ai-mcp-tools.ts";

const BASE = "https://ar.test";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

// A scripted stand-in for the AR API and the file plumbing. `routes` maps "METHOD /path" to a reply (or a function).
function setup(routes = {}, over = {}) {
  const calls = [], puts = [];
  const deps = {
    brands: ["stashbox", "solarmeister"],
    publicBase: BASE,
    async call(path, init = {}) {
      const key = `${init.method || "GET"} ${path}`;
      calls.push({ key, body: init.body });
      const r = routes[key];
      if (r === undefined) throw Object.assign(new Error(`unscripted ${key}`), { status: 500 });
      if (typeof r === "function") return r(init.body);
      if (r instanceof Error) throw r;
      return r;
    },
    allowedFileHost: (u) => u.hostname === "files.oaiusercontent.com",
    async fetchFile() { return over.bytes ?? PNG; },
    async putFile(url, headers, bytes) { puts.push({ url, headers, size: bytes.length }); },
    ...over.deps
  };
  return { deps, calls, puts };
}
const run = (a, cmd, s) => executeArAction(a, { brandSlug: "stashbox", ...cmd }, s.deps);
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof ArToolError && (status ? e.status === status : true) && (re ? re.test(e.message) : true));

const DOC = {
  entitlement: { arEnabled: true },
  triggers: [{ id: "t1", name: "Dirty Bird", status: "draft", target: {} }, { id: "t2", name: "No target", status: "draft" }],
  actions: [{ id: "a1", name: "Dirty Bird video", type: "video" }, { id: "a2", name: "Listen link", type: "link", label: "Listen", url: "https://stashbox.com/radio" }],
  rules: [{ id: "r1", triggerId: "t1", actionIds: ["a1", "a2"] }],
  sets: [{ id: "s1", name: "Covers", slug: "covers", triggerIds: ["t1"] }],
  qrs: [{ id: "q1", name: "Main", slug: "main", mode: "url", url: "https://stashbox.com/radio", isMain: true }, { id: "q2", name: "Covers", slug: "covers", mode: "scanner", setId: "s1" }]
};

test("every AR tool action exists in the executor list and in the MCP tool list (publishing is deliberately not a tool)", () => {
  const toolActions = MCP_TOOLS.filter((t) => t.action.startsWith("ar_")).map((t) => t.action).sort();
  assert.deepEqual(toolActions, ["ar_add_action", "ar_add_cover", "ar_add_to_set", "ar_connect", "ar_overview", "ar_prepare_upload", "ar_set_qr"]);
  assert.ok(toolActions.every((a) => AR_ACTIONS.includes(a)));
  assert.ok(!MCP_TOOLS.some((t) => /publish/.test(t.name)));
});

test("AR tools need the new ar:* permissions and only show the caller's brands", () => {
  const withoutAr = { clientId: "claude_code", brandSlugs: ["stashbox"], permissions: ["assets:read", "assets:write"] };
  assert.ok(!toolsForClient(withoutAr).some((t) => t.name.startsWith("elettro_ar_")));
  const readOnly = { clientId: "chatgpt_oauth", brandSlugs: ["stashbox"], permissions: ["ar:read"] };
  assert.deepEqual(toolsForClient(readOnly).map((t) => t.name), ["elettro_ar_overview"]);
  assert.equal(toolsForClient(readOnly)[0].annotations.readOnlyHint, true);
  const writer = { clientId: "claude_code", brandSlugs: ["stashbox", "elettro"], permissions: ["ar:read", "ar:write"] };
  assert.equal(toolsForClient(writer).length, 7);
  assert.deepEqual(toolsForClient(writer)[0].inputSchema.properties.brandSlug.enum, ["stashbox", "elettro"]);
  assert.equal(findAuthorizedTool("elettro_ar_add_cover", readOnly), undefined);
  for (const t of toolsForClient(writer).filter((x) => x.name !== "elettro_ar_overview")) {
    assert.equal(t.inputSchema.properties.confirmed.const, true, `${t.name} needs confirmation`);
    assert.ok(t.inputSchema.required.includes("confirmed"));
    assert.equal(t.annotations.readOnlyHint, false);
  }
});

test("overview summarises covers with their actions, sets and QR addresses", async () => {
  const s = setup({ "GET /ar/brands/stashbox": DOC });
  const r = await run("ar_overview", {}, s);
  assert.equal(r.arEnabled, true);
  assert.deepEqual(r.covers[0].actions.map((a) => a.name), ["Dirty Bird video", "Listen"]);
  assert.equal(r.covers[0].scannable, true);
  assert.equal(r.covers[1].scannable, false);
  assert.deepEqual(r.covers[0].sets, ["Covers"]);
  assert.deepEqual(r.qrs.map((q) => q.address), [`${BASE}/stashbox`, `${BASE}/stashbox/covers`]);
  assert.equal(summarize("x", {}, BASE).covers.length, 0);
});

test("unknown brands are refused and every write needs confirmed:true", async () => {
  const s = setup({});
  await assert.rejects(executeArAction("ar_overview", { brandSlug: "nope" }, s.deps), (e) => e.status === 403);
  for (const a of ["ar_prepare_upload", "ar_add_cover", "ar_add_action", "ar_connect", "ar_add_to_set", "ar_publish_set", "ar_set_qr"]) {
    await rejects(run(a, { kind: "image", name: "x" }, s), 400, /confirmation/);
  }
  assert.equal(s.calls.length, 0);
});

test("prepare_upload asks the AR API for the right kind", async () => {
  const s = setup({ "POST /ar/brands/stashbox/uploads": (b) => ({ key: `stashbox/images/k.${b.contentType === "image/png" ? "png" : "jpg"}`, url: "https://s3.test/u", headers: { "content-type": b.contentType }, maxBytes: 5 }) });
  const r = await run("ar_prepare_upload", { kind: "image", contentType: "image/png", confirmed: true }, s);
  assert.equal(r.key, "stashbox/images/k.png");
  assert.equal(s.calls[0].body.kind, "image");
  await rejects(run("ar_prepare_upload", { kind: "audio", confirmed: true }, s), 400);
  const v = await run("ar_prepare_upload", { kind: "video", confirmed: true }, setup({ "POST /ar/brands/stashbox/uploads": (b) => ({ key: "k", url: "u", headers: {}, maxBytes: 1, ct: b.contentType }) }));
  assert.match(v.next, /MP4/);
});

test("add_cover with imageKey compiles into a draft", async () => {
  const s = setup({ "POST /ar/brands/stashbox/triggers/compile": (b) => ({ item: { id: "t9", name: b.name, status: "draft" }, crop: { left: 128 }, source: { width: 1024 } }) });
  const r = await run("ar_add_cover", { name: "Super Funk", imageKey: "stashbox/images/a.png", confirmed: true }, s);
  assert.equal(r.draft, true);
  assert.equal(r.cover.id, "t9");
  assert.equal(s.calls[0].body.imageKey, "stashbox/images/a.png");
  assert.equal(s.puts.length, 0);
});

test("add_cover with a ChatGPT file link: approved host only, JPEG/PNG only, uploaded then compiled", async () => {
  const routes = {
    "POST /ar/brands/stashbox/uploads": () => ({ key: "stashbox/images/new.png", url: "https://s3.test/put", headers: { "content-type": "image/png" } }),
    "POST /ar/brands/stashbox/triggers/compile": (b) => ({ item: { id: "t5", name: b.name, status: "draft" }, crop: {}, source: {} })
  };
  const s = setup(routes);
  const ok = await run("ar_add_cover", { name: "Cover", file: { download_url: "https://files.oaiusercontent.com/f/1", file_id: "x" }, confirmed: true }, s);
  assert.equal(ok.cover.id, "t5");
  assert.deepEqual(s.puts.map((p) => p.url), ["https://s3.test/put"]);
  assert.equal(s.calls[1].body.imageKey, "stashbox/images/new.png");
  const s2 = setup(routes);
  await rejects(run("ar_add_cover", { name: "C", file: { download_url: "https://evil.example.com/x.png", file_id: "x" }, confirmed: true }, s2), 403, /approved host/);
  await rejects(run("ar_add_cover", { name: "C", file: { download_url: "http://files.oaiusercontent.com/x", file_id: "x" }, confirmed: true }, s2), 403);
  await rejects(run("ar_add_cover", { name: "C", file: { download_url: "not a url", file_id: "x" }, confirmed: true }, s2), 400);
  await rejects(run("ar_add_cover", { name: "C", confirmed: true }, s2), 400, /imageKey/);
  const gif = setup(routes, { bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 1, 2]) });
  await rejects(run("ar_add_cover", { name: "C", file: { download_url: "https://files.oaiusercontent.com/f/2", file_id: "x" }, confirmed: true }, gif), 422, /JPEG or PNG/);
  assert.equal(s2.puts.length + gif.puts.length, 0);
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPG), "image/jpeg");
  assert.equal(sniffImage(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test("add_action builds a video or a link and refuses anything else", async () => {
  const s = setup({ "POST /ar/brands/stashbox/actions": (b) => ({ item: { id: "a9", name: b.name, type: b.type } }) });
  await run("ar_add_action", { type: "video", name: "Clip", videoKey: "stashbox/video/c.mp4", fit: "float", confirmed: true }, s);
  assert.deepEqual(s.calls[0].body, { type: "video", name: "Clip", videoKey: "stashbox/video/c.mp4", fit: "float", loop: true });
  await run("ar_add_action", { type: "link", name: "Listen", url: "https://stashbox.com/radio", confirmed: true }, s);
  assert.deepEqual(s.calls[1].body, { type: "link", name: "Listen", label: "Listen", url: "https://stashbox.com/radio" });
  await rejects(run("ar_add_action", { type: "model", name: "x", confirmed: true }, s), 400);
  await rejects(run("ar_add_action", { type: "video", name: "x", confirmed: true }, s), 400, /videoKey/);
});

test("connect creates a rule, or replaces the cover's existing one", async () => {
  const s = setup({
    "GET /ar/brands/stashbox": DOC,
    "POST /ar/brands/stashbox/rules": (b) => ({ item: { id: "rNew", actionIds: b.actionIds } }),
    "PATCH /ar/brands/stashbox/rules/r1": (b) => ({ item: { id: "r1", actionIds: b.actionIds } })
  });
  const fresh = await run("ar_connect", { triggerId: "t2", actionIds: ["a1", "a1", "a2"], confirmed: true }, s);
  assert.equal(fresh.replacedExisting, false);
  assert.deepEqual(fresh.rule.actionIds, ["a1", "a2"]);
  const again = await run("ar_connect", { triggerId: "t1", actionIds: ["a2"], confirmed: true }, s);
  assert.equal(again.replacedExisting, true);
  await rejects(run("ar_connect", { triggerId: "t1", actionIds: [], confirmed: true }, s), 400);
});

test("add_to_set adds to an existing set by id or name, or creates one", async () => {
  const s = setup({
    "GET /ar/brands/stashbox": DOC,
    "PATCH /ar/brands/stashbox/sets/s1": (b) => ({ item: { id: "s1", name: "Covers", triggerIds: b.triggerIds } }),
    "POST /ar/brands/stashbox/sets": (b) => ({ item: { id: "sNew", name: b.name, slug: b.slug } })
  });
  const a = await run("ar_add_to_set", { setName: "covers", triggerIds: ["t2"], confirmed: true }, s);
  assert.equal(a.created, false);
  assert.deepEqual(s.calls.find((c) => c.key.startsWith("PATCH")).body.triggerIds, ["t1", "t2"]);
  const b = await run("ar_add_to_set", { setName: "Summer Merch!", triggerIds: ["t1"], confirmed: true }, s);
  assert.equal(b.created, true);
  assert.equal(s.calls.at(-1).body.slug, "summer-merch");
  await rejects(run("ar_add_to_set", { setId: "gone", triggerIds: ["t1"], confirmed: true }, s), 404);
  await rejects(run("ar_add_to_set", { triggerIds: ["t1"], confirmed: true }, s), 400);
  await rejects(run("ar_add_to_set", { setName: "!!!", triggerIds: ["t1"], confirmed: true }, s), 400);
});

test("publish_set reports the API's problem list in plain words", async () => {
  const s = setup({ "POST /ar/brands/stashbox/sets/s1/publish": Object.assign(new Error("set is not ready to publish"), { status: 422, problems: ['trigger "No target" has no tracking image'] }) });
  await assert.rejects(run("ar_publish_set", { setId: "s1", confirmed: true }, s), (e) => e.status === 422 && e.problems[0].includes("No target"));
  const ok = setup({ "POST /ar/brands/stashbox/sets/s1/publish": { manifestUrl: "https://ar.test/m.json", triggers: 2 } });
  const r = await run("ar_publish_set", { setId: "s1", confirmed: true }, ok);
  assert.equal(r.published, true);
  assert.match(r.note, /public/);
});

test("set_qr repoints a code or creates one, validating the mode", async () => {
  const s = setup({
    "PATCH /ar/brands/stashbox/qrs/q1": (b) => ({ item: { id: "q1", name: "Main", mode: b.mode } }),
    "POST /ar/brands/stashbox/qrs": (b) => ({ item: { id: "qN", name: b.name, slug: b.slug, mode: b.mode } })
  });
  const moved = await run("ar_set_qr", { qrId: "q1", mode: "scanner", setId: "s1", confirmed: true }, s);
  assert.equal(moved.live, true);
  assert.deepEqual(s.calls[0].body, { mode: "scanner", setId: "s1" });
  const made = await run("ar_set_qr", { name: "Album Sleeves", mode: "url", url: "https://stashbox.com/radio", confirmed: true }, s);
  assert.equal(made.address, `${BASE}/stashbox/album-sleeves`);
  await rejects(run("ar_set_qr", { qrId: "q1", mode: "carrier-pigeon", confirmed: true }, s), 400);
  await rejects(run("ar_set_qr", { qrId: "q1", mode: "scanner", confirmed: true }, s), 400, /setId/);
});
