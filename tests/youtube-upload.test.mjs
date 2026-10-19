import test from "node:test";
import assert from "node:assert/strict";
import { uploadRequest, handler } from "../services/youtube-upload-lambda/index.mjs";

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
