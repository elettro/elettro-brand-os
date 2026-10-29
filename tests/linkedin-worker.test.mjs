import test from "node:test";
import assert from "node:assert/strict";
import { littleText, commentaryFor, publishRequest, account, hasValidLogin, linkedin, publish, publishingTick, handler, secretKeyFor, renewRecord } from "../services/linkedin-lambda/index.mjs";

const ROOT = "/1---elettro-brand-os/brands/elettro/";
const NOW = new Date("2026-10-25T00:00:00Z");
const MEMBER = "urn:li:person:abc123XYZ";
const record = { accessToken: "member-token", memberUrn: MEMBER, brand: "elettro", expiresAt: "2026-12-18T21:56:00.000Z" };
const post = (over = {}) => ({ id: "p1", placement: "post", caption: "Problem, then fix.", hashtags: ["#marketing", "elettro"], dropboxPath: ROOT + "pic.jpg", channelId: MEMBER, title: "Fix it", ...over });
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

test("little text escapes LinkedIn's markup characters", () => {
  assert.equal(littleText("A_B (c) #d @e *f* ~g~ {h} [i] <j> | \\"), "A\\_B \\(c\\) \\#d \\@e \\*f\\* \\~g\\~ \\{h\\} \\[i\\] \\<j\\> \\| \\\\");
});

test("commentary escapes the caption and adds up to three clickable hashtags without duplicates", () => {
  assert.equal(commentaryFor(post()), "Problem, then fix.\n\n{hashtag|\\#|marketing} {hashtag|\\#|elettro}");
  assert.equal(commentaryFor(post({ hashtags: ["a", "#A", "b", "c", "d"] })), "Problem, then fix.\n\n{hashtag|\\#|a} {hashtag|\\#|b} {hashtag|\\#|c}");
  assert.equal(commentaryFor(post({ caption: "50% (est.)", hashtags: [] })), "50% \\(est.\\)");
  assert.equal(commentaryFor(post({ hashtags: ["bad tag!", "", "#"] })), "Problem, then fix.\n\n{hashtag|\\#|badtag}");
  assert.throws(() => commentaryFor(post({ caption: "  " })), /no caption/);
});

test("commentary stays within 3,000 characters even when escaping doubles the text", () => {
  const out = commentaryFor(post({ caption: "(".repeat(2000) }));
  assert.ok(out.length <= 3000, String(out.length));
  assert.ok(out.endsWith("{hashtag|\\#|marketing} {hashtag|\\#|elettro}"));
  assert.ok(!/\\\n/.test(out), "never ends an escape in the middle");
  assert.equal(commentaryFor(post({ caption: "x".repeat(3500), hashtags: [] })).length, 3000);
});

test("a claimed post is checked before anything goes out", () => {
  const request = publishRequest(post());
  assert.deepEqual([request.kind, request.channelId, request.title], ["image", MEMBER, "Fix it"]);
  assert.equal(publishRequest(post({ dropboxPath: ROOT + "clip.MOV" })).kind, "video");
  assert.equal(publishRequest(post({ dropboxPath: ROOT + "anim.gif" })).kind, "image");
  assert.throws(() => publishRequest(post({ dropboxPath: ROOT + "doc.pdf" })), /\.mp4 or \.mov/);
  assert.throws(() => publishRequest(post({ dropboxPath: "/other/pic.jpg" })), /inside/);
  assert.throws(() => publishRequest(post({ dropboxPath: ROOT + "../x.jpg" })), /inside/);
  assert.throws(() => publishRequest(post({ channelId: "12345" })), /member id/);
  assert.throws(() => publishRequest(post({ caption: "" })), /no caption/);
});

test("the token record comes from the member's secret and an expired login is refused", async () => {
  const reads = [];
  const read = async (id) => { reads.push(id); return record; };
  assert.equal((await account(MEMBER, { read, now: NOW })).accessToken, "member-token");
  assert.deepEqual(reads, ["elettro-brand-os-dev/linkedin/abc123XYZ"]);
  await assert.rejects(account(MEMBER, { read, now: new Date("2026-12-19T00:00:00Z") }), /expired; reconnect/);
  await assert.rejects(account(MEMBER, { read: async () => ({}), now: NOW }), /No LinkedIn token/);
  await assert.rejects(account("urn:li:person:", { read, now: NOW }), /member id/);
});

test("a valid login exists only when some stored token is unexpired", async () => {
  const names = async () => ["a", "b"];
  const secrets = { a: { accessToken: "x", expiresAt: "2026-10-01T00:00:00Z" }, b: { accessToken: "y", expiresAt: "2026-12-01T00:00:00Z" } };
  assert.equal(await hasValidLogin({ names, read: async (id) => secrets[id], now: NOW }), true);
  assert.equal(await hasValidLogin({ names: async () => ["a"], read: async (id) => secrets[id], now: NOW }), false);
  assert.equal(await hasValidLogin({ names: async () => [], read: async () => ({}), now: NOW }), false);
});

test("LinkedIn calls send the version headers and report LinkedIn's own error text", async () => {
  const calls = [];
  const ok = await linkedin("tok", "POST", "/posts", { a: 1 }, "post", async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, headers: headers({}), json: async () => ({}) }; });
  assert.equal(ok.status, 201);
  assert.equal(calls[0].url, "https://api.linkedin.com/rest/posts");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(calls[0].init.headers["linkedin-version"], "202608");
  assert.equal(calls[0].init.headers["x-restli-protocol-version"], "2.0.0");
  await assert.rejects(linkedin("tok", "POST", "/posts", {}, "post", async () => ({ ok: false, status: 422, json: async () => ({ message: "bad commentary" }) })), /LinkedIn post failed: bad commentary/);
  await assert.rejects(linkedin("tok", "GET", "/x", null, "check", async () => ({ ok: false, status: 401, json: async () => ({}) })), /rejected; reconnect LinkedIn/);
});

test("a photo post uploads the image, then posts it with alt text", async () => {
  const sent = [];
  const out = await publish(record, post(), {
    upload: { image: async () => "urn:li:image:C1" },
    call: async (method, path, body) => { sent.push({ method, path, body }); return { status: 201, headers: headers({ "x-restli-id": "urn:li:share:77" }), body: {} }; }
  });
  assert.deepEqual(out, { postId: "urn:li:share:77", permalink: "https://www.linkedin.com/feed/update/urn:li:share:77/" });
  assert.equal(sent[0].path, "/posts");
  assert.equal(sent[0].body.author, MEMBER);
  assert.equal(sent[0].body.visibility, "PUBLIC");
  assert.equal(sent[0].body.lifecycleState, "PUBLISHED");
  assert.deepEqual(sent[0].body.content, { media: { id: "urn:li:image:C1", altText: "Fix it" } });
  assert.match(sent[0].body.commentary, /^Problem, then fix\./);
});

test("a video is registered, sent part by part from Dropbox, finished, and only posted once AVAILABLE", async () => {
  const sent = [], transfers = [];
  let polls = 0;
  const call = async (method, path, body) => {
    sent.push({ method, path, body });
    if (path === "/videos?action=initializeUpload") {
      return { status: 200, headers: headers({}), body: { value: { video: "urn:li:video:V1", uploadToken: "tkn", uploadInstructions: [
        { uploadUrl: "https://upload/1", firstByte: 0, lastByte: 4194303 }, { uploadUrl: "https://upload/2", firstByte: 4194304, lastByte: 5000000 }] } } };
    }
    if (path.startsWith("/videos/")) return { status: 200, headers: headers({}), body: { status: ++polls < 2 ? "PROCESSING" : "AVAILABLE" } };
    if (path === "/posts") return { status: 201, headers: headers({ "x-restli-id": "urn:li:ugcPost:9" }), body: {} };
    return { status: 200, headers: headers({}), body: {} };
  };
  const fetchPart = async (url, init) => {
    transfers.push({ url, range: init.headers?.range, method: init.method || "GET" });
    return init.method === "PUT"
      ? { ok: true, status: 200, headers: headers({ etag: `"etag-${url.slice(-1)}"` }) }
      : { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  const out = await publish(record, post({ dropboxPath: ROOT + "clip.mp4" }), {
    call, fetchPart, link: async () => "https://dropbox/link", size: async () => 5000001, wait: async () => {}, pollMs: 1
  });
  assert.equal(out.postId, "urn:li:ugcPost:9");
  assert.deepEqual(sent[0].body.initializeUploadRequest, { owner: MEMBER, fileSizeBytes: 5000001, uploadCaptions: false, uploadThumbnail: false });
  assert.deepEqual(transfers.map((t) => [t.method, t.range || t.url]), [
    ["GET", "bytes=0-4194303"], ["PUT", "https://upload/1"], ["GET", "bytes=4194304-5000000"], ["PUT", "https://upload/2"]]);
  const finish = sent.find((s) => s.path === "/videos?action=finalizeUpload");
  assert.deepEqual(finish.body.finalizeUploadRequest, { video: "urn:li:video:V1", uploadToken: "tkn", uploadedPartIds: ["etag-1", "etag-2"] });
  assert.equal(polls, 2);
  assert.deepEqual(sent.at(-1).body.content, { media: { id: "urn:li:video:V1", title: "Fix it" } });
  assert.ok(sent.findIndex((s) => s.path === "/posts") > sent.findIndex((s) => s.path === "/videos?action=finalizeUpload"));
});

test("a video LinkedIn can't process fails the post instead of waiting forever", async () => {
  const call = async (method, path) => {
    if (path === "/videos?action=initializeUpload") return { status: 200, headers: headers({}), body: { value: { video: "urn:li:video:V1", uploadInstructions: [{ uploadUrl: "https://u", firstByte: 0, lastByte: 3 }] } } };
    if (path.startsWith("/videos/")) return { status: 200, headers: headers({}), body: { status: "PROCESSING_FAILED" } };
    return { status: 200, headers: headers({}), body: {} };
  };
  const fetchPart = async (url, init) => init.method === "PUT"
    ? { ok: true, status: 200, headers: headers({ etag: "e" }) } : { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(4) };
  await assert.rejects(publish(record, post({ dropboxPath: ROOT + "clip.mp4" }), { call, fetchPart, link: async () => "l", size: async () => 4, wait: async () => {} }), /could not process the video/);
});

test("the tick claims one LinkedIn post, publishes it and records the outcome", async () => {
  const calls = [];
  const callApi = async (payload) => { calls.push(payload); return payload.action === "claim-due-posts" ? { ok: true, missed: 0, stuck: 0, posts: [post()] } : { ok: true }; };
  const tick = await publishingTick({ callApi, loginOk: async () => true, publishOne: async () => ({ postId: "urn:li:share:1", permalink: "https://www.linkedin.com/feed/update/urn:li:share:1/" }) });
  assert.deepEqual(calls[0], { action: "claim-due-posts", destination: "linkedin", placements: ["post", "carousel"], limit: 1 });
  assert.deepEqual(calls[1], { action: "finish-post", id: "p1", externalPostId: "urn:li:share:1", externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:1/" });
  assert.equal(tick.published.length, 1);
});

test("a failed post is reported to the planner, not retried", async () => {
  const calls = [];
  const callApi = async (payload) => { calls.push(payload); return payload.action === "claim-due-posts" ? { ok: true, posts: [post()] } : { ok: true }; };
  const tick = await publishingTick({ callApi, loginOk: async () => true, publishOne: async () => { throw new Error("LinkedIn post failed: nope"); } });
  assert.deepEqual(calls[1], { action: "finish-post", id: "p1", error: "LinkedIn post failed: nope" });
  assert.equal(tick.published[0].error, "LinkedIn post failed: nope");
});

test("with no valid login the tick leaves approved posts alone", async () => {
  const calls = [];
  const tick = await publishingTick({ callApi: async (p) => { calls.push(p); return { ok: true, posts: [] }; }, loginOk: async () => false });
  assert.equal(calls.length, 0);
  assert.match(tick.skipped, /reconnect/);
  assert.deepEqual(tick.published, []);
});

test("a failed claim surfaces as a tick error", async () => {
  await assert.rejects(publishingTick({ callApi: async () => ({ ok: false, error: "db down" }), loginOk: async () => true }), /claim-due-posts failed: db down/);
});

test("the handler refuses web requests and unknown actions", async () => {
  assert.equal((await handler({ requestContext: {} })).statusCode, 403);
  assert.equal((await handler({ rawPath: "/x" })).statusCode, 403);
  assert.equal((await handler({ action: "nope" })).statusCode, 400);
});

const slideList = (n, ext = "jpg") => Array.from({ length: n }, (_, i) => ({ assetId: `a${i}`, dropboxPath: `${ROOT}img${i}.${ext}` }));
const carouselPost = (over = {}) => post({ placement: "carousel", slides: slideList(3), ...over });

test("a LinkedIn multi-image post needs 2-20 safe image slides", () => {
  const r = publishRequest(carouselPost());
  assert.deepEqual([r.kind, r.slidePaths.length, r.channelId], ["carousel", 3, MEMBER]);
  assert.equal(publishRequest(carouselPost({ slides: slideList(20, "png") })).slidePaths.length, 20);
  assert.throws(() => publishRequest(carouselPost({ slides: slideList(1) })), /needs 2-20 images; this one has 1/);
  assert.throws(() => publishRequest(carouselPost({ slides: slideList(21) })), /needs 2-20 images/);
  assert.throws(() => publishRequest(carouselPost({ slides: [] })), /this one has 0/);
  assert.throws(() => publishRequest(carouselPost({ slides: slideList(3, "gif") })), /\.jpg or \.png/);
  assert.throws(() => publishRequest(carouselPost({ slides: [...slideList(2), { dropboxPath: "/Personal/x.jpg" }] })), /brands/);
  assert.throws(() => publishRequest(carouselPost({ channelId: "nope" })), /no LinkedIn member id/);
});

test("a multi-image post uploads each image in order, then creates one post listing them", async () => {
  const sent = [], uploaded = [];
  let n = 0;
  const out = await publish(record, carouselPost(), {
    upload: { image: async (_t, req) => { uploaded.push(req.dropboxPath); return `urn:li:image:C${++n}`; } },
    call: async (method, path, body) => { sent.push({ method, path, body }); return { status: 201, headers: headers({ "x-restli-id": "urn:li:share:88" }), body: {} }; }
  });
  assert.deepEqual(out, { postId: "urn:li:share:88", permalink: "https://www.linkedin.com/feed/update/urn:li:share:88/" });
  assert.deepEqual(uploaded, [0, 1, 2].map((i) => `${ROOT}img${i}.jpg`));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.content, { multiImage: { images: [1, 2, 3].map((i) => ({ id: `urn:li:image:C${i}`, altText: "Fix it" })) } });
  assert.equal(sent[0].body.author, MEMBER);
});

test("a failed image upload creates no post", async () => {
  const sent = [];
  let n = 0;
  await assert.rejects(publish(record, carouselPost(), {
    upload: { image: async () => { if (++n === 2) throw new Error("LinkedIn image upload failed (HTTP 500)"); return "urn:li:image:C1"; } },
    call: async (...args) => { sent.push(args); return { status: 201, headers: headers({ "x-restli-id": "x" }), body: {} }; }
  }), /image upload failed/);
  assert.equal(sent.length, 0);
});
