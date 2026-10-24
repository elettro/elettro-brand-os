import test from "node:test";
import assert from "node:assert/strict";
import { captionFor, publishRequest, tokenRecord, graph, publishInstagram, publishFacebook, publishingTick, handler } from "../services/meta-lambda/index.mjs";
import { handlePlannerOps } from "../services/dev-api-lambda/planner-ops.mjs";

const ROOT = "/1---elettro-brand-os/brands/stashbox/";
const json = (statusCode, body) => ({ statusCode, body });
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
// Shaped like the secret meta-connect stores.
const record = { pageAccessToken: "page-token", pageId: "111", pageName: "Stashbox", instagramId: "222", instagramUsername: "stashboxmusic", brand: "stashbox" };
const post = (over = {}) => ({ id: "p1", placement: "reel", caption: "Live at the Dirty Bird", hashtags: ["#reggae", "stashbox"], dropboxPath: ROOT + "clip.mp4", channelId: "222", ...over });

test("captions add the hashtags, drop duplicates, and fit the network's limit", () => {
  assert.equal(captionFor("instagram", post()), "Live at the Dirty Bird\n\n#reggae #stashbox");
  assert.equal(captionFor("facebook", post({ hashtags: ["a", "#A", "b"] })), "Live at the Dirty Bird\n\n#a #b");
  assert.equal(captionFor("instagram", post({ hashtags: [] })), "Live at the Dirty Bird");
  const long = "x".repeat(2300);
  assert.equal(captionFor("instagram", post({ caption: long })).length, 2200);
  assert.equal(captionFor("facebook", post({ caption: long })), long + "\n\n#reggae #stashbox");
  assert.equal(captionFor("facebook", post({ caption: "z".repeat(5100) })).length, 5000);
  assert.equal(captionFor("instagram", post({ caption: "y".repeat(2190), hashtags: ["reggae", "stashbox"] })), "y".repeat(2190));
  assert.throws(() => captionFor("instagram", post({ caption: "  " })), /no caption/);
});

test("a claimed post is checked for its network and placement before anything goes out", () => {
  assert.deepEqual(publishRequest("instagram", post()), {
    destination: "instagram", placement: "reel", kind: "video", dropboxPath: ROOT + "clip.mp4",
    caption: "Live at the Dirty Bird\n\n#reggae #stashbox", channelId: "222"
  });
  assert.equal(publishRequest("facebook", post({ placement: "post", dropboxPath: ROOT + "wide.mov" })).kind, "video");
  assert.equal(publishRequest("facebook", post({ placement: "post", dropboxPath: ROOT + "pic.png" })).kind, "image");
  assert.equal(publishRequest("instagram", post({ placement: "post", dropboxPath: ROOT + "pic.JPG" })).kind, "image");
  const story = publishRequest("instagram", post({ placement: "story", caption: "", dropboxPath: ROOT + "story.mp4" }));
  assert.equal(story.caption, "");
  assert.equal(story.kind, "video");
  assert.equal(publishRequest("facebook", post({ placement: "story", caption: "", dropboxPath: ROOT + "s.png" })).kind, "image");
  assert.throws(() => publishRequest("instagram", post({ placement: "story", dropboxPath: ROOT + "s.png" })), /Stories take JPEG/);
  assert.throws(() => publishRequest("instagram", post({ placement: "banner" })), /banner posts aren't published automatically/);
  assert.throws(() => publishRequest("instagram", post({ placement: "post", dropboxPath: ROOT + "pic.png" })), /JPEG/);
  assert.throws(() => publishRequest("instagram", post({ placement: "post", dropboxPath: ROOT + "clip.mp4" })), /JPEG/);
  assert.throws(() => publishRequest("facebook", post({ dropboxPath: ROOT + "pic.jpg" })), /Reel needs a video/);
  assert.throws(() => publishRequest("facebook", post({ dropboxPath: "/elsewhere/clip.mp4" })), /must be inside/);
  assert.throws(() => publishRequest("facebook", post({ dropboxPath: ROOT + "../x/clip.mp4" })), /must be inside/);
  assert.throws(() => publishRequest("facebook", post({ dropboxPath: ROOT + "notes.pdf" })), /\.mp4 or \.mov/);
});

test("the token record is found by Page id for Facebook and by Instagram id for Instagram", async () => {
  const stored = {
    "meta/111": record,
    "meta/333": { ...record, pageId: "333", instagramId: "444", pageAccessToken: "other" },
    "meta/555": { ...record, pageId: "555", instagramId: "666", revokedAt: "2026-10-01T00:00:00Z" }
  };
  const deps = { names: async () => Object.keys(stored), read: async (id) => stored[id] };
  assert.equal((await tokenRecord("facebook", "333", deps)).pageAccessToken, "other");
  assert.equal((await tokenRecord("instagram", "222", deps)).pageId, "111");
  await assert.rejects(tokenRecord("instagram", "666", deps), /No instagram login is connected for 666/);
  await assert.rejects(tokenRecord("facebook", "999", deps), /No facebook login is connected/);
});

test("Meta errors surface their user-facing message", async () => {
  await assert.rejects(graph("POST", "x/media", {}, "t", "Instagram upload", reply(400, { error: { message: "bad", error_user_msg: "The video is too long" } })),
    /Meta Instagram upload failed: The video is too long/);
  await assert.rejects(graph("GET", "x", {}, "t", "status", reply(500, {})), /Meta status failed: 500/);
});

test("an Instagram Reel creates a container, waits until it is FINISHED, then publishes", async () => {
  const calls = [];
  const states = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
  const call = async (method, path, params, what) => {
    calls.push({ method, path, params, what });
    if (path === "222/media") return { id: "c1" };
    if (path === "c1") return { status_code: states.shift() };
    if (path === "222/media_publish") return { id: "m9" };
    return { permalink: "https://www.instagram.com/reel/abc/" };
  };
  let waits = 0;
  const out = await publishInstagram(record, publishRequest("instagram", post()), { call, link: async (p) => "https://dl/" + p.split("/").pop(), wait: async () => { waits++; } });
  assert.deepEqual(out, { postId: "m9", permalink: "https://www.instagram.com/reel/abc/" });
  assert.equal(waits, 2);
  assert.deepEqual(calls[0].params, { media_type: "REELS", video_url: "https://dl/clip.mp4", caption: "Live at the Dirty Bird\n\n#reggae #stashbox", share_to_feed: "true" });
  assert.deepEqual(calls.find((c) => c.path === "222/media_publish").params, { creation_id: "c1" });
});

test("an Instagram photo uses image_url, and a missing permalink doesn't fail a live post", async () => {
  const seen = [];
  const call = async (method, path, params) => {
    seen.push(path);
    if (path === "222/media") { assert.equal(params.image_url, "https://dl/pic.jpg"); assert.ok(!("media_type" in params)); return { id: "c2" }; }
    if (path === "c2") return { status_code: "FINISHED" };
    if (path === "222/media_publish") return { id: "m10" };
    throw new Error("no permalink");
  };
  const req = publishRequest("instagram", post({ placement: "post", dropboxPath: ROOT + "pic.jpg" }));
  assert.deepEqual(await publishInstagram(record, req, { call, link: async () => "https://dl/pic.jpg", wait: async () => {} }), { postId: "m10", permalink: null });
});

test("Instagram processing errors, expiry and timeouts are reported, and nothing is published", async () => {
  const run = (state, extra = {}) => {
    const seen = [];
    const call = async (method, path) => { seen.push(path); return path === "222/media" ? { id: "c" } : state; };
    return { seen, p: publishInstagram(record, publishRequest("instagram", post()), { call, link: async () => "u", wait: async () => {}, pollMs: 1000, limitMs: 2000, ...extra }) };
  };
  const error = run({ status_code: "ERROR", status: "Video codec not supported" });
  await assert.rejects(error.p, /could not process the media: Video codec not supported/);
  assert.ok(!error.seen.includes("222/media_publish"));
  await assert.rejects(run({ status_code: "EXPIRED" }).p, /could not process the media: EXPIRED/);
  await assert.rejects(run({ status_code: "IN_PROGRESS" }).p, /still processing the media after 2 s/);
  await assert.rejects(publishInstagram({ ...record, instagramId: null }, publishRequest("instagram", post()), { link: async () => "u" }), /No Instagram account is linked/);
});

test("Facebook: a photo and a wide video post in one call, with the planner caption", async () => {
  const calls = [];
  const call = async (method, path, params) => { calls.push({ path, params }); return path.endsWith("/photos") ? { id: "ph", post_id: "111_999" } : { id: "v7" }; };
  const photo = await publishFacebook(record, publishRequest("facebook", post({ placement: "post", dropboxPath: ROOT + "pic.png", channelId: "111" })), { call, link: async () => "https://dl/pic.png" });
  assert.deepEqual(photo, { postId: "111_999", permalink: "https://www.facebook.com/111_999" });
  assert.deepEqual(calls[0], { path: "111/photos", params: { url: "https://dl/pic.png", message: "Live at the Dirty Bird\n\n#reggae #stashbox", published: "true" } });
  const video = await publishFacebook(record, publishRequest("facebook", post({ placement: "post", dropboxPath: ROOT + "wide.mp4", channelId: "111" })), { call, link: async () => "https://dl/wide.mp4" });
  assert.deepEqual(video, { postId: "v7", permalink: "https://www.facebook.com/111/videos/v7" });
  assert.deepEqual(calls[1].params, { file_url: "https://dl/wide.mp4", description: "Live at the Dirty Bird\n\n#reggae #stashbox" });
});

test("a Facebook Reel starts, uploads from the link, then finishes as PUBLISHED", async () => {
  const calls = [];
  const call = async (method, path, params) => { calls.push({ path, params }); return path === "111/video_reels" && params.upload_phase === "start" ? { video_id: "r5" } : { success: true }; };
  let uploaded;
  const upload = async (url, opts) => { uploaded = { url, opts }; return { ok: true, status: 200, json: async () => ({ success: true }) }; };
  const out = await publishFacebook(record, publishRequest("facebook", post({ channelId: "111" })), { call, link: async () => "https://dl/clip.mp4", upload });
  assert.deepEqual(out, { postId: "r5", permalink: "https://www.facebook.com/reel/r5" });
  assert.equal(uploaded.url, "https://rupload.facebook.com/video-upload/v26.0/r5");
  assert.equal(uploaded.opts.headers.file_url, "https://dl/clip.mp4");
  assert.equal(uploaded.opts.headers.authorization, "OAuth page-token");
  assert.deepEqual(calls[1].params, { upload_phase: "finish", video_id: "r5", video_state: "PUBLISHED", description: "Live at the Dirty Bird\n\n#reggae #stashbox" });
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ debug_info: { message: "bad file" } }) });
  await assert.rejects(publishFacebook(record, publishRequest("facebook", post({ channelId: "111" })), { call, link: async () => "u", upload: failing }), /Reel upload failed: bad file/);
  assert.equal(calls.filter((c) => c.params.upload_phase === "finish").length, 1, "no finish after a failed upload");
});

test("the tick claims Reels and feed posts per network, publishes, and reports each outcome", async () => {
  const sent = [];
  const callApi = async (payload) => {
    sent.push(payload);
    if (payload.action === "claim-due-posts") {
      return { ok: true, missed: payload.destination === "instagram" ? 1 : 0, stuck: 0, posts: [{ id: payload.destination + "-1" }] };
    }
    return { ok: true };
  };
  const publish = async (destination) => {
    if (destination === "facebook") throw new Error("Meta Facebook photo failed: (#200) permission denied");
    return { postId: "m1", permalink: "https://www.instagram.com/p/x/" };
  };
  const tick = await publishingTick({ callApi, publish });
  assert.deepEqual(sent.filter((s) => s.action === "claim-due-posts"),
    [{ action: "claim-due-posts", destination: "instagram", placements: ["reel", "post", "story"], limit: 1 },
     { action: "claim-due-posts", destination: "facebook", placements: ["reel", "post", "story"], limit: 1 }]);
  assert.deepEqual(sent.filter((s) => s.action === "finish-post"), [
    { action: "finish-post", id: "instagram-1", externalPostId: "m1", externalUrl: "https://www.instagram.com/p/x/" },
    { action: "finish-post", id: "facebook-1", error: "Meta Facebook photo failed: (#200) permission denied" }
  ]);
  assert.equal(tick.missed, 1);
  assert.deepEqual(tick.errors, []);
});

test("one network failing to claim doesn't stop the other, and the tick says so", async () => {
  const callApi = async (payload) => {
    if (payload.action === "claim-due-posts" && payload.destination === "instagram") throw new Error("claim-due-posts crashed: timeout");
    return { ok: true, posts: [] };
  };
  const tick = await publishingTick({ callApi, publish: async () => { throw new Error("unused"); } });
  assert.deepEqual(tick.errors, ["instagram: claim-due-posts crashed: timeout"]);
  const refused = await publishingTick({ callApi: async () => ({ ok: false, error: "boom" }), publish: async () => ({}) });
  assert.equal(refused.errors.length, 2);
});

test("the handler refuses HTTP callers and unknown actions", async () => {
  assert.equal((await handler({ rawPath: "/x" })).statusCode, 403);
  assert.equal((await handler({ requestContext: {} })).statusCode, 403);
  assert.equal((await handler({ action: "nope" })).statusCode, 400);
});

test("claim-due-posts only claims the named placements, and all of them when none are named", async () => {
  const claims = [];
  const client = { query: async (text, values) => { if (text.includes("RETURNING sp.\"id\"")) claims.push(values); return { rowCount: 0, rows: [] }; }, end: async () => {} };
  await handlePlannerOps({ action: "claim-due-posts", destination: "instagram", placements: ["reel", "post"], limit: 1 }, async () => client, json);
  await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  await handlePlannerOps({ action: "claim-due-posts", destination: "youtube", placements: [] }, async () => client, json);
  assert.deepEqual(claims, [["instagram", 1, ["reel", "post"]], ["youtube", 2, null], ["youtube", 2, null]]);
});

test("a stuck upload is retried once only when the worker asks, and requeue-failed needs a destination", async () => {
  const sweeps = [];
  const client = { query: async (text, values) => { if (text.includes("never reported back")) sweeps.push(values); return { rowCount: 0, rows: [] }; }, end: async () => {} };
  await handlePlannerOps({ action: "claim-due-posts", destination: "tiktok", retryStuck: true }, async () => client, json);
  await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  assert.deepEqual(sweeps, [["tiktok", true], ["youtube", false]]);
  assert.equal((await handlePlannerOps({ action: "requeue-failed" }, async () => client, json)).statusCode, 400);
  const requeued = await handlePlannerOps({ action: "requeue-failed", destination: "tiktok" }, async () => client, json);
  assert.equal(requeued.statusCode, 200);
});

test("an Instagram Story posts the bare media with media_type STORIES and no caption", async () => {
  const calls = [];
  const call = async (method, path, params) => {
    calls.push({ method, path, params });
    if (path === "222/media") return { id: "c1" };
    if (path === "c1") return { status_code: "FINISHED" };
    if (path === "222/media_publish") return { id: "s9" };
    return { permalink: "https://www.instagram.com/stories/stashboxmusic/s9/" };
  };
  const deps = { call, link: async () => "https://dl/story", wait: async () => {} };
  const video = await publishInstagram(record, publishRequest("instagram", post({ placement: "story", caption: "", dropboxPath: ROOT + "story.mp4" })), deps);
  assert.deepEqual(calls[0].params, { media_type: "STORIES", video_url: "https://dl/story" });
  assert.equal(video.postId, "s9");
  calls.length = 0;
  await publishInstagram(record, publishRequest("instagram", post({ placement: "story", caption: "", dropboxPath: ROOT + "story.jpg" })), deps);
  assert.deepEqual(calls[0].params, { media_type: "STORIES", image_url: "https://dl/story" });
});

test("a Facebook photo Story uploads unpublished, then becomes a Story", async () => {
  const calls = [];
  const call = async (method, path, params) => { calls.push({ path, params }); return path.endsWith("/photos") ? { id: "ph1" } : { success: true, post_id: "st1" }; };
  const out = await publishFacebook(record, publishRequest("facebook", post({ placement: "story", caption: "", dropboxPath: ROOT + "s.jpg", channelId: "111" })), { call, link: async () => "https://dl/s.jpg" });
  assert.deepEqual(calls, [
    { path: "111/photos", params: { url: "https://dl/s.jpg", published: "false" } },
    { path: "111/photo_stories", params: { photo_id: "ph1" } }
  ]);
  assert.deepEqual(out, { postId: "st1", permalink: "https://www.facebook.com/stories/111" });
});

test("a Facebook video Story starts, uploads from the link, then finishes; a failed upload never finishes", async () => {
  const calls = [];
  const call = async (method, path, params) => { calls.push({ path, params }); return params.upload_phase === "start" ? { video_id: "v1", upload_url: "https://rupload/v1" } : { success: true, post_id: "st2" }; };
  let uploaded;
  const upload = async (url, opts) => { uploaded = { url, opts }; return { ok: true, status: 200, json: async () => ({ success: true }) }; };
  const req = publishRequest("facebook", post({ placement: "story", caption: "", dropboxPath: ROOT + "s.mp4", channelId: "111" }));
  const out = await publishFacebook(record, req, { call, link: async () => "https://dl/s.mp4", upload });
  assert.equal(uploaded.url, "https://rupload/v1");
  assert.equal(uploaded.opts.headers.file_url, "https://dl/s.mp4");
  assert.deepEqual(calls[1], { path: "111/video_stories", params: { upload_phase: "finish", video_id: "v1" } });
  assert.deepEqual(out, { postId: "st2", permalink: "https://www.facebook.com/stories/111" });
  calls.length = 0;
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ debug_info: { message: "bad file" } }) });
  await assert.rejects(publishFacebook(record, req, { call, link: async () => "u", upload: failing }), /Story upload failed: bad file/);
  assert.equal(calls.filter((c) => c.params.upload_phase === "finish").length, 0);
});
