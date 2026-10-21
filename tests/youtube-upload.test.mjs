import test from "node:test";
import assert from "node:assert/strict";
import { uploadRequest, uploadFromPost, handler } from "../services/youtube-upload-lambda/index.mjs";

const valid = {
  channelId: "UC6C6Z_erONmKW67pF5AyYkA",
  dropboxPath: "/1---elettro-brand-os/brands/stashbox/shorts/test.mp4",
  title: "Stashbox test upload"
};

test("a valid request defaults to private, Music, not made for kids", () => {
  const request = uploadRequest(valid);
  assert.equal(request.privacyStatus, "private");
  assert.equal(request.snippet.categoryId, "10");
  assert.equal(request.madeForKids, false);
  assert.deepEqual(request.snippet.tags, []);
});

test("files outside the brand Dropbox root are refused", () => {
  assert.throws(() => uploadRequest({ ...valid, dropboxPath: "/Personal/video.mp4" }), /brands/);
  assert.throws(() => uploadRequest({ ...valid, dropboxPath: "/1---elettro-brand-os/brands/../x.mp4" }), /brands/);
});

test("bad channel ids, titles and privacy values are refused", () => {
  assert.throws(() => uploadRequest({ ...valid, channelId: "stashbox" }), /channelId/);
  assert.throws(() => uploadRequest({ ...valid, title: "" }), /title/);
  assert.throws(() => uploadRequest({ ...valid, title: "x".repeat(101) }), /title/);
  assert.throws(() => uploadRequest({ ...valid, privacyStatus: "everyone" }), /privacyStatus/);
});

test("HTTP events are turned away; the worker is invoke-only", async () => {
  const response = await handler({ ...valid, requestContext: { http: { method: "POST" } } });
  assert.equal(response.statusCode, 403);
});

test("a scheduled post becomes a clean upload: planner title, caption plus hashtags, tags without #", () => {
  const fields = uploadFromPost({
    channelId: valid.channelId, dropboxPath: valid.dropboxPath, filename: "clip-07.mp4",
    title: "Get Up <Stand Up> live", caption: "Front row at Jupiter Farms.", hashtags: ["#reggae", "stashbox"]
  }, "private");
  assert.equal(fields.title, "Get Up Stand Up live");
  assert.equal(fields.description, "Front row at Jupiter Farms.\n\n#reggae #stashbox");
  assert.deepEqual(fields.tags, ["reggae", "stashbox"]);
  assert.equal(uploadRequest(fields).privacyStatus, "private");
});

test("AI-made posts are declared to YouTube as altered or synthetic content; others are not", () => {
  const post = { channelId: valid.channelId, dropboxPath: valid.dropboxPath, title: "Help Jamaica Now" };
  assert.equal(uploadRequest(uploadFromPost({ ...post, synthetic: true }, "private")).containsSyntheticMedia, true);
  assert.equal(uploadRequest(uploadFromPost(post, "private")).containsSyntheticMedia, false);
});

test("recording date comes from the post, else today; location only when given", () => {
  const post = { channelId: valid.channelId, dropboxPath: valid.dropboxPath, title: "Tangled Up in Blue" };
  assert.equal(uploadRequest(uploadFromPost({ ...post, recordingDate: "2026-10-11" }, "private")).recordingDetails.recordingDate, "2026-10-11T12:00:00.000Z");
  const today = new Date().toISOString().slice(0, 10);
  const plain = uploadRequest(uploadFromPost(post, "private")).recordingDetails;
  assert.equal(plain.recordingDate, `${today}T12:00:00.000Z`);
  assert.ok(!("location" in plain), "no location unless the brand has one");
  const located = uploadRequest(uploadFromPost({ ...post, location: { latitude: 26.07, longitude: -80.27, description: "Stashbox" } }, "private")).recordingDetails;
  assert.deepEqual([located.location, located.locationDescription], [{ latitude: 26.07, longitude: -80.27 }, "Stashbox"]);
  assert.throws(() => uploadRequest({ ...valid, recordingDate: "10/11/2026" }), /recordingDate/);
});

test("the paid-promotion question is always answered: No unless the post says Yes", () => {
  const post = { channelId: valid.channelId, dropboxPath: valid.dropboxPath, title: "Help Jamaica Now" };
  assert.equal(uploadRequest(uploadFromPost(post, "private")).paidPromotion, false);
  assert.equal(uploadRequest(uploadFromPost({ ...post, paidPromotion: true }, "private")).paidPromotion, true);
  assert.equal(uploadRequest(valid).paidPromotion, false);
});

test("videos are English unless the post names another language", () => {
  const post = { channelId: valid.channelId, dropboxPath: valid.dropboxPath, title: "Podcast" };
  assert.equal(uploadRequest(uploadFromPost(post, "private")).snippet.defaultAudioLanguage, "en");
  const de = uploadRequest(uploadFromPost({ ...post, language: "de" }, "private")).snippet;
  assert.deepEqual([de.defaultLanguage, de.defaultAudioLanguage], ["de", "de"]);
  assert.throws(() => uploadRequest({ ...valid, language: "German" }), /language/);
});

test("with no planner title the asset title, then the filename, is used", () => {
  assert.equal(uploadFromPost({ assetTitle: "Dirty Bird", filename: "x.mp4" }, "private").title, "Dirty Bird");
  assert.equal(uploadFromPost({ filename: "stashbox-dirty-bird-9x16.mp4" }, "private").title, "stashbox-dirty-bird-9x16");
});
