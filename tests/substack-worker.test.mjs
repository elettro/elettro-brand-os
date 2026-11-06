import test from "node:test";
import assert from "node:assert/strict";
import { titleFor, buildDoc, inlineNodes, postRequest, requestFromPost, uploadImage, publish, publishingTick, account, check, rejectionDetail, MAX_TITLE } from "../services/substack-lambda/index.mjs";

const PATH = "/1---elettro-brand-os/brands/elettro/image/a.jpg";
const record = { cookie: "substack.sid=secretvalue", subdomain: "elettro", userId: "42", handle: "elettro" };
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), headers: new Headers() });

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
  assert.deepEqual(api[0], { action: "claim-due-posts", destination: "substack", placements: ["post", "carousel"], limit: 1 });
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

test("markdown: headings, bold, italic, links, quotes and dividers become Substack nodes", () => {
  const doc = buildDoc("# Big\n\nHello **bold** and *soft* with [Elettro](https://elettro.com).\n\n> quoted\n\n---", null, { markdown: true });
  assert.deepEqual(doc.content[0], { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Big" }] });
  const para = doc.content[1].content;
  assert.deepEqual(para.map((n) => n.text), ["Hello ", "bold", " and ", "soft", " with ", "Elettro", "."]);
  assert.deepEqual(para[1].marks, [{ type: "strong" }]);
  assert.deepEqual(para[3].marks, [{ type: "em" }]);
  assert.deepEqual(para[5].marks, [{ type: "link", attrs: { href: "https://elettro.com" } }]);
  assert.equal(doc.content[2].type, "blockquote");
  assert.equal(doc.content[2].content[0].content[0].text, "quoted");
  assert.deepEqual(doc.content[3], { type: "horizontal_rule" });
});

test("markdown: nested marks, unsafe links and stray asterisks stay safe", () => {
  assert.deepEqual(inlineNodes("**[x](https://a.b)**")[0].marks.map((m) => m.type), ["strong", "link"]);
  const unsafe = inlineNodes("[x](javascript:alert(1))");
  assert.equal(unsafe.map((n) => n.text).join(""), "[x](javascript:alert(1))");
  assert.ok(unsafe.every((n) => !n.marks), "an unsafe link must stay plain text, never a link");
  assert.deepEqual(inlineNodes("5 * 3 = 15").map((n) => n.text), ["5 * 3 = 15"]);
  assert.equal(inlineNodes("a **unclosed").length, 1);
});

test("plain mode (planner captions) never turns # or * into formatting; manual posts use markdown", () => {
  const doc = buildDoc("# not a heading **nor bold**", null);
  assert.equal(doc.content[0].type, "paragraph");
  assert.equal(doc.content[0].content[0].text, "# not a heading **nor bold**");
  assert.equal(postRequest({ brand: "elettro", title: "T", text: "b" }).markdown, true);
  assert.equal(requestFromPost({ channelId: "elettro", title: "Hi", caption: "Body", dropboxPath: PATH }).markdown, false);
});

const GALLERY = (n) => Array.from({ length: n }, (_, i) => ({ dropboxPath: `/1---elettro-brand-os/brands/elettro/image/g${i + 1}.jpg` }));

test("gallery: planner slides become one request with every picture in order, plain text, never emailed", () => {
  const r = requestFromPost({ placement: "carousel", channelId: "elettro", title: "Five things we shipped", caption: "Intro", slides: GALLERY(5) });
  assert.equal(r.gallery, true);
  assert.equal(r.paths.length, 5);
  assert.ok(r.paths[0].endsWith("g1.jpg") && r.paths[4].endsWith("g5.jpg"));
  assert.equal(r.send, false);
  assert.equal(r.markdown, false);
  assert.equal(requestFromPost({ channelId: "elettro", title: "Hi", caption: "b", dropboxPath: PATH }).gallery, false);
});

test("gallery: fewer than 2 or more than 20 pictures, or a non-image, fails the post instead of posting something smaller", () => {
  const base = { placement: "carousel", channelId: "elettro", title: "T", caption: "c" };
  assert.throws(() => requestFromPost({ ...base, slides: GALLERY(1) }), /2-20/);
  assert.throws(() => requestFromPost({ ...base, slides: [] }), /2-20/);
  assert.throws(() => requestFromPost({ ...base, slides: GALLERY(21) }), /2-20/);
  assert.throws(() => requestFromPost({ ...base, slides: [...GALLERY(2), { dropboxPath: PATH.replace("a.jpg", "a.mp4") }] }), /image/);
  assert.equal(requestFromPost({ ...base, slides: GALLERY(20) }).paths.length, 20);
});

test("gallery: the document opens with the intro text, then lists the pictures in order; a single picture still leads", () => {
  const doc = buildDoc("Intro text", ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"], { imagesAfterText: true });
  assert.deepEqual(doc.content.map((n) => n.type), ["paragraph", "captionedImage", "captionedImage", "captionedImage"]);
  assert.deepEqual(doc.content.slice(1).map((n) => n.content[0].attrs.src), ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"]);
  assert.deepEqual(buildDoc("Body", "https://cdn/x.jpg").content.map((n) => n.type), ["captionedImage", "paragraph"]);
  assert.deepEqual(buildDoc("Body", null).content.map((n) => n.type), ["paragraph"]);
});

test("gallery: publish uploads every picture first, then makes one draft and publishes it once", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.split("/api/v1")[1]}`);
    if (url.endsWith("/image")) return reply(200, { url: `https://cdn/${calls.filter((c) => c.endsWith("/image")).length}.jpg` });
    if (url.endsWith("/drafts")) return reply(200, { id: 55, slug: "gal" });
    return reply(200, { slug: "gal" });
  };
  const request = requestFromPost({ placement: "carousel", channelId: "elettro", title: "Gallery", caption: "Intro", slides: GALLERY(3) });
  const downloaded = [];
  const out = await publish(record, request, { download: async (p) => { downloaded.push(p); return Buffer.from("img"); }, fetchImpl });
  assert.deepEqual(calls, ["POST /image", "POST /image", "POST /image", "POST /drafts", "POST /drafts/55/publish"]);
  assert.equal(downloaded.length, 3);
  assert.equal(out.url, "https://elettro.substack.com/p/gal");
});

test("gallery: if one picture fails to upload nothing is drafted or published", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.split("/api/v1")[1]}`);
    return url.endsWith("/image") && calls.length === 2 ? reply(500, {}) : reply(200, { url: "https://cdn/x.jpg" });
  };
  const request = requestFromPost({ placement: "carousel", channelId: "elettro", title: "G", caption: "c", slides: GALLERY(3) });
  await assert.rejects(publish(record, request, { download: async () => Buffer.from("i"), fetchImpl }), /image upload failed/);
  assert.ok(!calls.some((c) => c.includes("/drafts")), "no draft may be created after a failed upload");
});

test("gallery: the tick claims posts and carousels; manual galleries take dropboxPaths", async () => {
  const api = [];
  await publishingTick({ callApi: async (p) => { api.push(p); return p.action === "claim-due-posts" ? { ok: true, posts: [] } : { ok: true }; } });
  assert.deepEqual(api[0].placements, ["post", "carousel"]);
  const m = postRequest({ brand: "elettro", title: "T", text: "b", dropboxPaths: GALLERY(3).map((s) => s.dropboxPath) });
  assert.equal(m.gallery, true);
  assert.equal(m.paths.length, 3);
  assert.throws(() => postRequest({ brand: "elettro", title: "T", dropboxPaths: GALLERY(1).map((s) => s.dropboxPath) }), /at least 2/);
  assert.throws(() => postRequest({ brand: "elettro", title: "T", dropboxPaths: GALLERY(21).map((s) => s.dropboxPath) }), /up to 20/);
});

test("a 403 that is not a sign-in answer is reported as a block, not an expired cookie", async () => {
  const blocked = async () => reply(403, "<html><title>Just a moment...</title>Cloudflare</html>");
  await assert.rejects(uploadImage(record, Buffer.from("a"), PATH, { fetchImpl: blocked }), /not a plain expired cookie/);
  const signIn = async () => reply(403, { errors: [{ msg: "Please sign in" }] });
  await assert.rejects(uploadImage(record, Buffer.from("a"), PATH, { fetchImpl: signIn }), /reconnect/);
  assert.equal(rejectionDetail({ status: 403, headers: new Headers() }, "plain text").kind, "refused without a sign-in message");
});
