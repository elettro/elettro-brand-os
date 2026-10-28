import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, postRequest, chunkPlan, requestFromPost, postInfo, manualSettings, revokeRecord, revokeTokens, handler } from "../services/tiktok-lambda/index.mjs";

const NOW = new Date("2026-10-21T00:00:00Z");
const app = { clientKey: "key", clientSecret: "secret" };
const record = {
  accessToken: "old", accessExpiresAt: "2026-10-21T06:00:00.000Z",
  refreshToken: "r1", refreshExpiresAt: "2027-10-20T16:00:00.000Z", scope: "video.publish",
  openId: "-0001abc", username: "stashboxmusic", brand: "stashbox"
};
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test("tokens with less than 12 hours left are renewed, others are left alone", () => {
  assert.equal(needsRefresh(record, NOW), true);
  assert.equal(needsRefresh({ ...record, accessExpiresAt: "2026-10-21T20:00:00.000Z" }, NOW), false);
  assert.equal(needsRefresh({ ...record, accessExpiresAt: undefined }, NOW), true);
});

test("a refresh rewrites access and refresh tokens with new expiries", async () => {
  let sent;
  const post = async (url, init) => { sent = Object.fromEntries(init.body); return reply(200, {
    access_token: "new", expires_in: 86400, refresh_token: "r2", refresh_expires_in: 31536000, scope: "video.publish,video.list"
  })(); };
  const next = await refreshRecord(record, app, NOW, post);
  assert.deepEqual(sent, { client_key: "key", client_secret: "secret", grant_type: "refresh_token", refresh_token: "r1" });
  assert.equal(next.accessToken, "new");
  assert.equal(next.accessExpiresAt, "2026-10-22T00:00:00.000Z");
  assert.equal(next.refreshToken, "r2");
  assert.equal(next.refreshExpiresAt, "2027-10-21T00:00:00.000Z");
  assert.equal(next.username, "stashboxmusic");
});

test("a refresh without a new refresh token keeps the old one and its expiry", async () => {
  const next = await refreshRecord(record, app, NOW, reply(200, { access_token: "new", expires_in: 86400 }));
  assert.equal(next.refreshToken, "r1");
  assert.equal(next.refreshExpiresAt, record.refreshExpiresAt);
});

test("TikTok errors surface with their description", async () => {
  await assert.rejects(refreshRecord(record, app, NOW, reply(400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired." })),
    /TikTok refresh failed: Refresh token is invalid or expired/);
  await assert.rejects(refreshRecord({ ...record, refreshToken: "" }, app, NOW), /no refresh token/);
});

test("the worker refuses HTTP events and unknown actions", async () => {
  assert.equal((await handler({ rawPath: "/x" })).statusCode, 403);
  assert.equal((await handler({ action: "delete-everything" })).statusCode, 400);
});

const MB = 1024 * 1024;
const post = { brand: "stashbox", dropboxPath: "/1---elettro-brand-os/brands/stashbox/shorts/clip.mp4", caption: "Live at Studio One" };

test("a post request defaults to draft mode and keeps the caption", () => {
  assert.deepEqual(postRequest(post), { ...post, mode: "draft" });
  assert.equal(postRequest({ ...post, mode: "direct" }).mode, "direct");
});

test("post requests outside the brand Dropbox, non-videos, long captions and odd modes are refused", () => {
  assert.throws(() => postRequest({ ...post, dropboxPath: "/Personal/clip.mp4" }), /brands/);
  assert.throws(() => postRequest({ ...post, dropboxPath: "/1---elettro-brand-os/brands/stashbox/../x/clip.mp4" }), /brands/);
  assert.throws(() => postRequest({ ...post, dropboxPath: "/1---elettro-brand-os/brands/stashbox/cover.jpg" }), /video/);
  assert.throws(() => postRequest({ ...post, caption: "x".repeat(2201) }), /2200/);
  assert.throws(() => postRequest({ ...post, mode: "public" }), /mode/);
  assert.throws(() => postRequest({ ...post, brand: "Stash Box" }), /brand/);
});

test("videos up to 10 MB go in one chunk; bigger ones in 10 MB chunks with the remainder on the last", () => {
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(10 * MB), { chunkSize: 10 * MB, count: 1 });
  assert.deepEqual(chunkPlan(15 * MB), { chunkSize: 15 * MB, count: 1 });
  assert.deepEqual(chunkPlan(30 * MB), { chunkSize: 10 * MB, count: 3 });
  assert.deepEqual(chunkPlan(95 * MB), { chunkSize: 10 * MB, count: 9 });
  assert.throws(() => chunkPlan(0), /empty/);
});

test("a bad post request is refused before any TikTok or Dropbox call", async () => {
  const r = await handler({ action: "post", brand: "stashbox", dropboxPath: "/elsewhere/clip.mp4" });
  assert.equal(r.statusCode, 400);
});

test("a planner post becomes a request for its account with caption and hashtags", () => {
  const r = requestFromPost({
    channelId: "-0001abc", dropboxPath: post.dropboxPath, caption: "Angel In Your Bed, live", hashtags: ["#stashbox", "livemusic", " "]
  }, "draft");
  assert.equal(r.openId, "-0001abc");
  assert.equal(r.mode, "draft");
  assert.equal(r.caption, "Angel In Your Bed, live\n\n#stashbox #livemusic");
  assert.equal(requestFromPost({ channelId: "x", dropboxPath: post.dropboxPath, caption: "y".repeat(3000) }, "direct").caption.length, 2200);
});

test("an AI-made planner post carries TikTok's AI-generated label; others don't", () => {
  assert.equal(requestFromPost({ channelId: "x", dropboxPath: post.dropboxPath, synthetic: true }, "direct").aigc, true);
  assert.equal(requestFromPost({ channelId: "x", dropboxPath: post.dropboxPath }, "direct").aigc, false);
});

test("a planner post with a file outside the brand Dropbox is refused", () => {
  assert.throws(() => requestFromPost({ channelId: "x", dropboxPath: "/Personal/a.mp4" }, "draft"), /brands/);
});

test("direct posts carry the creator's Review-page choices; none means no post", () => {
  const info = postInfo({ privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: true, allowDuet: false, allowStitch: true, yourBrand: true }, "hi", "");
  assert.deepEqual(info, { title: "hi", privacy_level: "FOLLOWER_OF_CREATOR", disable_comment: false, disable_duet: true, disable_stitch: false,
    brand_organic_toggle: true, brand_content_toggle: false });
  assert.equal(postInfo({ privacyLevel: "PUBLIC_TO_EVERYONE" }, "hi", "SELF_ONLY").privacy_level, "SELF_ONLY");
  assert.throws(() => postInfo(null, "hi", ""), /TikTok card/);
});

test("a planner post brings its TikTok settings along", () => {
  const settings = { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true };
  assert.deepEqual(requestFromPost({ channelId: "x", dropboxPath: post.dropboxPath, tiktok: settings }, "direct").settings, settings);
  assert.equal(requestFromPost({ channelId: "x", dropboxPath: post.dropboxPath }, "direct").settings, null);
});

test("a manual post uses the TikTok card's choices, or private for a bare console test", () => {
  assert.equal(manualSettings({}).privacyLevel, "SELF_ONLY");
  assert.deepEqual(manualSettings({ settings: { privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: true, yourBrand: true } }),
    { privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: true, allowDuet: false, allowStitch: false, yourBrand: true, brandedContent: false });
  assert.throws(() => manualSettings({ settings: {} }), /who can view/);
  assert.throws(() => manualSettings({ settings: { privacyLevel: "SELF_ONLY", brandedContent: true } }), /can't be private/);
});

test("revoke sends the app keys and the access token to TikTok's revoke endpoint", async () => {
  let call;
  await revokeRecord(record, app, async (url, init) => { call = { url, body: Object.fromEntries(init.body) }; return reply(200, {})(); });
  assert.match(call.url, /\/v2\/oauth\/revoke\/$/);
  assert.deepEqual(call.body, { client_key: "key", client_secret: "secret", token: "old" });
  await assert.rejects(revokeRecord(record, app, reply(400, { error: "invalid_request", error_description: "bad token" })), /TikTok revoke failed: bad token/);
});

test("disconnect treats a login TikTok already rejects as disconnected, but not other failures", async () => {
  const dead = async () => { throw new Error("TikTok refresh failed: Refresh token is invalid or expired."); };
  assert.deepEqual(await revokeTokens(record, app, { refresh: dead, revoke: async () => {}, now: NOW }), { alreadyInvalid: true });
  const fresh = { ...record, accessExpiresAt: "2026-10-22T00:00:00.000Z" };
  let revoked = false;
  assert.deepEqual(await revokeTokens(fresh, app, { refresh: dead, revoke: async () => { revoked = true; }, now: NOW }), { alreadyInvalid: false });
  assert.equal(revoked, true);
  await assert.rejects(revokeTokens(fresh, app, { revoke: async () => { throw new Error("TikTok revoke failed: 503"); }, now: NOW }), /503/);
});

import { photoRequestFromPost, photoPayload, hostImages, postPhotos } from "../services/tiktok-lambda/index.mjs";

const PHOTO_ROOT = "/1---elettro-brand-os/brands/stashbox/";
const photoSlides = (n, ext = "jpg") => Array.from({ length: n }, (_, i) => ({ assetId: `a${i}`, dropboxPath: `${PHOTO_ROOT}img${i}.${ext}` }));
const photoPost = (over = {}) => ({ id: "p1", placement: "carousel", caption: "Gear day.\nFive pieces.", hashtags: ["#stashbox"], channelId: "open1", slides: photoSlides(3), ...over });

test("a TikTok photo carousel needs 2-35 safe JPEG/WebP slides and a caption", () => {
  const r = photoRequestFromPost(photoPost(), "draft");
  assert.deepEqual([r.slidePaths.length, r.title, r.description, r.openId, r.mode], [3, "Gear day.", "Gear day.\nFive pieces.\n\n#stashbox", "open1", "draft"]);
  assert.equal(photoRequestFromPost(photoPost({ slides: photoSlides(35, "webp") }), "draft").slidePaths.length, 35);
  assert.equal(photoRequestFromPost(photoPost({ caption: "x".repeat(100) }), "draft").title.length, 90);
  assert.throws(() => photoRequestFromPost(photoPost({ slides: photoSlides(1) }), "draft"), /needs 2-35 images; this one has 1/);
  assert.throws(() => photoRequestFromPost(photoPost({ slides: photoSlides(36) }), "draft"), /needs 2-35 images/);
  assert.throws(() => photoRequestFromPost(photoPost({ slides: [] }), "draft"), /this one has 0/);
  assert.throws(() => photoRequestFromPost(photoPost({ slides: photoSlides(3, "png") }), "draft"), /\.jpg, \.jpeg or \.webp/);
  assert.throws(() => photoRequestFromPost(photoPost({ slides: [...photoSlides(2), { dropboxPath: "/Personal/x.jpg" }] }), "draft"), /brands/);
  assert.throws(() => photoRequestFromPost(photoPost({ caption: "", hashtags: [] }), "draft"), /no caption/);
  assert.throws(() => photoRequestFromPost(photoPost(), "later"), /draft/);
});

test("a draft carousel sends only the text and the image URLs; a direct one adds the creator's choices", () => {
  const urls = ["https://media.example.com/a.jpg", "https://media.example.com/b.jpg"];
  const draft = photoPayload(photoRequestFromPost(photoPost(), "draft"), urls, null);
  assert.deepEqual(draft, { media_type: "PHOTO", post_mode: "MEDIA_UPLOAD",
    post_info: { title: "Gear day.", description: "Gear day.\nFive pieces.\n\n#stashbox" },
    source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: urls } });
  const settings = { privacyLevel: "SELF_ONLY", allowComment: true, yourBrand: false, brandedContent: false };
  const direct = photoPayload(photoRequestFromPost(photoPost({ tiktok: settings, synthetic: true }), "direct"), urls, { privacy_level_options: ["SELF_ONLY"], comment_disabled: true });
  assert.equal(direct.post_mode, "DIRECT_POST");
  assert.deepEqual([direct.post_info.privacy_level, direct.post_info.disable_comment, direct.is_aigc], ["SELF_ONLY", true, true]);
  assert.throws(() => photoPayload(photoRequestFromPost(photoPost({ tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" } }), "direct"), urls, { privacy_level_options: ["SELF_ONLY"] }), /does not allow PUBLIC_TO_EVERYONE/);
  assert.throws(() => photoPayload(photoRequestFromPost(photoPost(), "direct"), urls, { privacy_level_options: ["SELF_ONLY"] }), /No TikTok settings/);
});

test("slides are copied from Dropbox to the verified image host, in order, and fail clearly without one", async () => {
  const puts = [];
  const request = photoRequestFromPost(photoPost(), "draft");
  const urls = await hostImages(request, { bucket: "media-bucket", baseUrl: "https://media.example.com", stamp: 7,
    link: async (p) => "https://dl/" + p.split("/").pop(), get: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    put: async (params) => { puts.push(params); } });
  assert.deepEqual(urls, [1, 2, 3].map((i) => `https://media.example.com/tiktok/p1-7/${i}.jpg`));
  assert.deepEqual(puts.map((p) => [p.Bucket, p.Key, p.ContentType]), [1, 2, 3].map((i) => ["media-bucket", `tiktok/p1-7/${i}.jpg`, "image/jpeg"]));
  await assert.rejects(hostImages(request, { bucket: "", baseUrl: "" }), /TIKTOK_PHOTO_BUCKET/);
  await assert.rejects(hostImages(request, { bucket: "b", baseUrl: "https://x", link: async () => "u", get: async () => ({ ok: false, status: 403 }), put: async () => {} }), /Dropbox download failed \(HTTP 403\)/);
});

test("a carousel post hosts the images, then makes one content/init call with their URLs", async () => {
  const calls = [];
  const out = await postPhotos(photoRequestFromPost(photoPost(), "draft"), {
    account: async () => ({ accessToken: "tok", username: "stashboxmusic" }),
    host: async () => ["https://m/1.jpg", "https://m/2.jpg", "https://m/3.jpg"],
    call: async (path, token, body) => { calls.push({ path, token, body }); return { publish_id: "pub1" }; }
  });
  assert.deepEqual(out, { handle: "@stashboxmusic", mode: "draft", images: 3, publishId: "pub1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/post/publish/content/init/");
  assert.deepEqual(calls[0].body.source_info.photo_images, ["https://m/1.jpg", "https://m/2.jpg", "https://m/3.jpg"]);
  // A direct post asks TikTok for the creator's options first.
  calls.length = 0;
  await postPhotos(photoRequestFromPost(photoPost({ tiktok: { privacyLevel: "SELF_ONLY" } }), "direct"), {
    account: async () => ({ accessToken: "tok", openId: "o" }), host: async () => ["https://m/1.jpg", "https://m/2.jpg"],
    call: async (path) => { calls.push(path); return path.includes("creator_info") ? { privacy_level_options: ["SELF_ONLY"] } : { publish_id: "pub2" }; }
  });
  assert.deepEqual(calls, ["/post/publish/creator_info/query/", "/post/publish/content/init/"]);
});
