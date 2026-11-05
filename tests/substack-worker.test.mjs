import test from "node:test";
import assert from "node:assert/strict";
import { titleFor, buildDoc, postRequest, requestFromPost, uploadImage, publish, publishingTick, account, check, MAX_TITLE } from "../services/substack-lambda/index.mjs";

const PATH = "/1---elettro-brand-os/brands/elettro/image/a.jpg";
const record = { cookie: "substack.sid=secretvalue", subdomain: "elettro", userId: "42", handle: "elettro" };
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("title: planner title, else first caption line, cut at a word within the limit", () => {
  assert.equal(titleFor({ title: "  Hello   world ", caption: "x" }), "Hello world");
  assert.equal(titleFor({ caption: "First line\nsecond" }), "First line");
  const long = titleFor({ title: "word ".repeat(80) });
  assert.ok(long.length <= MAX_TITLE && long.endsWith("…"));
  assert.equal(titleFor({}), "");
});

test("document: hero image first, then one paragraph per blank-line block", () => {
  const doc = buildDoc("One\nstill one\n\nTwo", "https://img/x.jpg");
  assert.equal(doc.type, "doc");
  assert.equal(doc.content[0].type, "captionedImage");
  assert.equal(doc.content[0].content[0].attrs.src, "https://img/x.jpg");
  assert.deepEqual(doc.content.slice(1).map((p) => p.content[0].text), ["One still one", "Two"]);
  assert.equal(buildDoc("Only text").content.length, 1);
});

test("requests: manual and planner posts are validated; scheduled posts never email", () => {
  assert.equal(postRequest({ brand: "elettro", title: "T", text: "b", dropboxPath: PATH }).send, false);
  assert.equal(postRequest({ brand: "elettro", title: "T", send: true }).send, true);
  assert.throws(() => postRequest({ brand: "elettro", title: "" }), /title/);
  assert.throws(() => postRequest({ brand: "elettro", title: "T", dropboxPath: "/etc/passwd" }), /inside/);
  assert.throws(() => postRequest({ brand: "elettro", title: "T", dropboxPath: PATH.replace("a.jpg", "a.mp4") }), /picture/);
  const r = requestFromPost({ channelId: "elettro", title: "Hi", caption: "Body", dropboxPath: PATH });
  assert.equal(r.send, false);
  assert.equal(r.subdomain, "elettro");
  assert.throws(() => requestFromPost({ channelId: "bad host", caption: "x", dropboxPath: PATH }), /not linked/);
  assert.throws(() => requestFromPost({ channelId: "elettro", dropboxPath: PATH }), /title or a caption/);
});

test("uploadImage posts the picture as a data URL with the cookie and returns the hosted URL; oversize and bad login are refused", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { url: "https://cdn/x.jpg" }); };
  assert.equal(await uploadImage(record, Buffer.from("abc"), PATH, { fetchImpl }), "https://cdn/x.jpg");
  assert.equal(seen.url, "https://elettro.substack.com/api/v1/image");
  assert.equal(seen.init.headers.cookie, record.cookie);
  assert.match(String(seen.init.body), /data%3Aimage%2Fjpeg%3Bbase64%2CYWJj/);
  await assert.rejects(uploadImage(record, Buffer.alloc(11 * 1024 * 1024), PATH, {}), /10 MB/);
  await assert.rejects(uploadImage(record, Buffer.from("a"), PATH, { fetchImpl: async () => reply(401, {}) }), /reconnect/);
});

test("publish uploads the picture, creates the draft with the byline, then publishes it web-only", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith("/image")) return reply(200, { url: "https://cdn/x.jpg" });
    if (url.endsWith("/drafts")) return reply(200, { id: 777, slug: "hello" });
    return reply(200, { slug: "hello" });
  };
  const out = await publish(record, { title: "Hello", text: "Body", path: PATH, send: false }, { download: async () => Buffer.from("img"), fetchImpl });
  assert.deepEqual(calls.map((c) => c.url.replace("https://elettro.substack.com/api/v1", "")), ["/image", "/drafts", "/drafts/777/publish"]);
  const draft = JSON.parse(calls[1].body);
  assert.equal(draft.draft_title, "Hello");
  assert.deepEqual(draft.draft_bylines, [{ id: 42, is_guest: false }]);
  assert.ok(JSON.parse(draft.draft_body).content.some((n) => n.type === "captionedImage"));
  assert.deepEqual(JSON.parse(calls[2].body), { send: false, share_automatically: false });
  assert.equal(out.url, "https://elettro.substack.com/p/hello");
  assert.equal(out.id, "777");
});

test("a refused publish deletes the orphan draft and reports the failure", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.method + " " + url.split("/api/v1")[1]);
    if (url.endsWith("/drafts")) return reply(200, { id: 9 });
    if (init.method === "DELETE") return reply(200, {});
    return reply(500, {});
  };
  await assert.rejects(publish(record, { title: "T", text: "b", path: null, send: false }, { fetchImpl }), /refused to publish/);
  assert.deepEqual(calls, ["POST /drafts", "POST /drafts/9/publish", "DELETE /drafts/9"]);
});

test("the tick claims only Substack posts, publishes, and reports success or failure to the planner", async () => {
  const api = [];
  const callApi = async (p) => {
    api.push(p);
    if (p.action === "claim-due-posts") return { ok: true, missed: 0, stuck: 0, posts: [
      { id: "p1", channelId: "elettro", title: "Hi", caption: "Body", dropboxPath: PATH },
      { id: "p2", channelId: "bad host", caption: "x", dropboxPath: PATH }] };
    return { ok: true };
  };
  const tick = await publishingTick({ callApi, find: async () => record, send: async () => ({ id: "1", url: "https://elettro.substack.com/p/hi" }) });
  assert.deepEqual(api[0], { action: "claim-due-posts", destination: "substack", placements: ["post"], limit: 1 });
  assert.equal(tick.published[0].externalUrl, "https://elettro.substack.com/p/hi");
  assert.match(tick.published[1].error, /not linked/);
  assert.equal(api.filter((p) => p.action === "finish-post").length, 2);
});

test("account reads the stored login, and refuses a missing or revoked one", async () => {
  assert.equal((await account(null, "elettro", { read: async () => record })).subdomain, "elettro");
  await assert.rejects(account(null, "elettro", { read: async () => ({ ...record, revokedAt: "x" }) }), /reconnect/);
  await assert.rejects(account(null, "elettro", { read: async () => { throw new Error("nope"); } }), /reconnect/);
  assert.equal((await account("elettro", null, { names: async () => ["a"], read: async () => ({ ...record, brand: "elettro" }) })).userId, "42");
  await assert.rejects(account("other", null, { names: async () => ["a"], read: async () => ({ ...record, brand: "elettro" }) }), /No Substack publication/);
});

test("check reads the profile only", async () => {
  const out = await check(record, { fetchImpl: async (url, init) => { assert.equal(init.method, "GET"); assert.ok(url.endsWith("/user/profile/self")); return reply(200, { id: 42, handle: "elettro" }); } });
  assert.deepEqual(out, { userId: "42", handle: "elettro" });
});
