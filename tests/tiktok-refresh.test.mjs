import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, postRequest, chunkPlan, requestFromPost, handler } from "../services/tiktok-lambda/index.mjs";

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

test("videos up to 64 MB go in one chunk; bigger ones in 10 MB chunks with the remainder on the last", () => {
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(64 * MB), { chunkSize: 64 * MB, count: 1 });
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

test("a planner post with a file outside the brand Dropbox is refused", () => {
  assert.throws(() => requestFromPost({ channelId: "x", dropboxPath: "/Personal/a.mp4" }, "draft"), /brands/);
});
