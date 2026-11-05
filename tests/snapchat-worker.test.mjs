import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import {
  needsRefresh, refreshRecord, refreshAll, account, spotlightText, postRequest, requestFromPost, encryptVideo, splitParts,
  uploadMedia, publishMedia, publish, publishingTick, DESCRIPTION_MAX
} from "../services/snapchat-lambda/index.mjs";

const NOW = new Date("2026-11-05T12:00:00Z");
const ID = "d6ed1cac-e0cd-4109-bf04-539cb8591838";
const record = { accessToken: "old", accessExpiresAt: "2026-11-05T12:10:00.000Z", refreshToken: "r1", profileId: ID, handle: "@stashboxmusic", brand: "stashbox" };
const app = { clientId: "cid", clientSecret: "secret" };
const path = "/1---elettro-brand-os/brands/stashbox/video/9x16/clip.mp4";
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

test("a token is renewed when less than 20 minutes remain, or when its expiry is unknown", () => {
  assert.equal(needsRefresh(record, NOW), true);
  assert.equal(needsRefresh({ ...record, accessExpiresAt: "2026-11-05T12:25:00.000Z" }, NOW), false);
  assert.equal(needsRefresh({ ...record, accessExpiresAt: undefined }, NOW), true);
});

test("a refresh posts the refresh_token grant with the app credentials and keeps the old refresh token when none is returned", async () => {
  let sent;
  const next = await refreshRecord(record, app, NOW, async (url, init) => { sent = { url, body: init.body }; return reply(200, { access_token: "new", expires_in: 1800 }); });
  assert.equal(sent.url, "https://accounts.snapchat.com/login/oauth2/access_token");
  assert.equal(sent.body.get("grant_type"), "refresh_token");
  assert.equal(sent.body.get("client_id"), "cid");
  assert.equal(sent.body.get("refresh_token"), "r1");
  assert.equal(next.accessToken, "new");
  assert.equal(next.refreshToken, "r1");
  assert.equal(next.accessExpiresAt, "2026-11-05T12:30:00.000Z");
});

test("a rotated refresh token is stored; a refusal throws a readable error", async () => {
  const next = await refreshRecord(record, app, NOW, async () => reply(200, { access_token: "n", refresh_token: "r2", expires_in: 1800 }));
  assert.equal(next.refreshToken, "r2");
  await assert.rejects(refreshRecord(record, app, NOW, async () => reply(400, { error: "invalid_grant" })), /Snapchat refresh failed: invalid_grant/);
});

test("refreshAll renews what is due, skips revoked and fresh accounts, and one failure does not stop the rest", async () => {
  const records = {
    a: record,
    b: { ...record, profileId: "b", accessExpiresAt: "2026-11-05T13:00:00.000Z" },
    c: { ...record, profileId: "c", revokedAt: "2026-11-01T00:00:00Z" },
    d: { ...record, profileId: "d" }
  };
  const written = [];
  const summary = await refreshAll(NOW, {
    app, names: ["a", "b", "c", "d"], read: async (n) => records[n], write: async (n, r) => { written.push(n); },
    refresh: async (r) => { if (r.profileId === "d") throw new Error("boom"); return { ...r, accessToken: "x", accessExpiresAt: "2026-11-05T12:30:00.000Z" }; }
  });
  assert.deepEqual(written, ["a"]);
  assert.equal(summary.ok, false);
  assert.equal(summary.accounts.length, 3);
  assert.equal(summary.accounts[2].error, "boom");
});

test("account finds the profile by id, renews a nearly expired token first and refuses a missing one", async () => {
  const written = [];
  const deps = { names: ["elettro-brand-os-dev/snapchat/" + ID], read: async () => record, app: async () => app, write: async (n, r) => written.push(r), refresh: async (r) => ({ ...r, accessToken: "fresh", accessExpiresAt: "2099-01-01T00:00:00.000Z" }) };
  const found = await account(null, ID, { ...deps, read: async () => ({ ...record, accessExpiresAt: "2000-01-01T00:00:00.000Z" }) });
  assert.equal(found.accessToken, "fresh");
  assert.equal(written.length, 1);
  await assert.rejects(account(null, "ffffffff-0000-0000-0000-000000000000", deps), /No Snapchat profile is connected/);
});

test("a Spotlight description keeps the caption whole, adds hashtags only while they fit and never passes 160 characters", () => {
  assert.equal(spotlightText("Live tonight", ["stashbox", "reggae", "extra"]), "Live tonight #stashbox #reggae");
  const long = "word ".repeat(60);
  const text = spotlightText(long, ["tag"]);
  assert.ok(text.length <= DESCRIPTION_MAX);
  const nearly = "x".repeat(155);
  assert.equal(spotlightText(nearly, ["longhashtag"]), nearly);
});

test("post requests are limited to mp4 files inside the brand library, as a story or a spotlight", () => {
  assert.equal(postRequest({ brand: "stashbox", dropboxPath: path }).kind, "story");
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: path.replace(".mp4", ".mov") }), /mp4/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: "/other/clip.mp4" }), /must be inside/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: path, kind: "snap" }), /story/);
  assert.throws(() => postRequest({ brand: "Bad Brand", dropboxPath: path }), /brand/);
});

test("a planner post becomes a story without text, or a spotlight with its caption and tags", () => {
  const story = requestFromPost({ placement: "story", dropboxPath: path, caption: "ignored", hashtags: ["a"], channelId: ID });
  assert.equal(story.kind, "story");
  assert.equal(story.description, "");
  assert.equal(story.profileId, ID);
  const spot = requestFromPost({ placement: "spotlight", dropboxPath: path, caption: "Hello", hashtags: ["#reggae"], channelId: ID });
  assert.equal(spot.description, "Hello #reggae");
});

test("the video is encrypted with AES-256-CBC and decrypts back to the original, with a 32-byte key and 16-byte iv", () => {
  const video = Buffer.from("not really a video ".repeat(1000));
  const { encrypted, key, iv } = encryptVideo(video);
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.equal(Buffer.from(iv, "base64").length, 16);
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(key, "base64"), Buffer.from(iv, "base64"));
  assert.ok(Buffer.concat([decipher.update(encrypted), decipher.final()]).equals(video));
});

test("parts are at most the part size, in order, and the 35-part limit is enforced", () => {
  const parts = splitParts(Buffer.alloc(25), 10);
  assert.deepEqual(parts.map((p) => p.length), [10, 10, 5]);
  assert.throws(() => splitParts(Buffer.alloc(36), 1), /35/);
  assert.throws(() => splitParts(Buffer.alloc(0)), /empty/);
});

// A fake Snap: records every call and answers like the reference page describes.
function fakeSnap({ failPosts = 0 } = {}) {
  const calls = [];
  let postFailures = failPosts;
  const call = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method, auth: init.headers.authorization, body: init.body });
    if (u.pathname.endsWith("/media")) return reply(200, { request_status: "SUCCESS", media_id: "m1", add_path: "v1/media/m1/multipart-upload-v2", finalize_path: "v1/media/m1/multipart-upload-v2" });
    if (u.pathname.includes("multipart-upload")) return reply(200, { request_status: "SUCCESS" });
    if (/\/(stories|spotlights)$/.test(u.pathname)) {
      if (postFailures-- > 0) return reply(400, { request_status: "ERROR", error_code: "E3004", display_message: "media not ready" });
      return reply(200, { request_status: "SUCCESS", spotlight_id: "sp1" });
    }
    return reply(404, {});
  };
  return { call, calls };
}

test("a Spotlight upload creates the media, adds each part, finalizes, then posts with locale and description", async () => {
  const snap = fakeSnap();
  const video = { bytes: Buffer.from("video".repeat(100)), name: "clip.mp4" };
  const sent = await publish({ profileId: ID, accessToken: "tok", handle: "@stashboxmusic" }, { kind: "spotlight", description: "Hi #tag", dropboxPath: path }, { call: snap.call, download: async () => video, wait: async () => {} });
  assert.deepEqual(snap.calls.map((c) => c.path.replace(ID, ":id")), [
    "/v1/public_profiles/:id/media", "/v1/media/m1/multipart-upload-v2", "/v1/media/m1/multipart-upload-v2", "/v1/public_profiles/:id/spotlights"
  ]);
  assert.ok(snap.calls.every((c) => c.auth === "Bearer tok"));
  const created = JSON.parse(snap.calls[0].body);
  assert.equal(created.type, "VIDEO");
  assert.equal(Buffer.from(created.key, "base64").length, 32);
  assert.equal(snap.calls[1].body.get("action"), "ADD");
  assert.equal(snap.calls[1].body.get("part_number"), "1");
  assert.equal(snap.calls[2].body.get("action"), "FINALIZE");
  const post = JSON.parse(snap.calls[3].body);
  assert.deepEqual(post, { media_id: "m1", locale: "en_US", skip_save_to_profile: false, description: "Hi #tag" });
  assert.equal(sent.id, "sp1");
});

test("a Story posts only the media id", async () => {
  const snap = fakeSnap();
  await publishMedia(ID, "tok", "m1", { kind: "story" }, { call: snap.call, wait: async () => {} });
  assert.deepEqual(JSON.parse(snap.calls[0].body), { media_id: "m1" });
  assert.ok(snap.calls[0].path.endsWith("/stories"));
});

test("posting retries while Snap is still processing the upload, then gives up with Snap's own message", async () => {
  const waits = [];
  const ok = await publishMedia(ID, "tok", "m1", { kind: "story" }, { call: fakeSnap({ failPosts: 2 }).call, wait: async (ms) => waits.push(ms) });
  assert.equal(waits.length, 2);
  assert.ok(ok.id);
  await assert.rejects(publishMedia(ID, "tok", "m1", { kind: "story" }, { call: fakeSnap({ failPosts: 99 }).call, wait: async () => {}, tries: 3 }), /E3004 — media not ready/);
});

test("an upload without upload paths fails clearly", async () => {
  const call = async () => reply(200, { request_status: "SUCCESS", media_id: "m1" });
  await assert.rejects(uploadMedia(ID, "tok", { bytes: Buffer.from("x"), name: "a.mp4" }, { call }), /upload paths/);
});

test("the tick claims only story and spotlight posts, posts each and reports the outcome (or the error) to finish-post", async () => {
  const calls = [];
  const posts = [
    { id: "p1", placement: "spotlight", dropboxPath: path, caption: "Hi", hashtags: [], channelId: ID },
    { id: "p2", placement: "story", dropboxPath: path, channelId: ID }
  ];
  const callApi = async (payload) => {
    calls.push(payload);
    return payload.action === "claim-due-posts" ? { ok: true, posts, missed: 0, stuck: 0 } : { ok: true };
  };
  const out = await publishingTick({ callApi, find: async () => ({ profileId: ID }), send: async (r, req) => { if (req.kind === "story") throw new Error("nope"); return { id: "sp1" }; } });
  assert.deepEqual(calls[0].placements, ["story", "spotlight"]);
  assert.equal(calls[0].destination, "snapchat");
  assert.deepEqual(calls.slice(1), [{ action: "finish-post", id: "p1", externalPostId: "sp1" }, { action: "finish-post", id: "p2", error: "nope" }]);
  assert.equal(out.published.length, 2);
});
