import test from "node:test";
import assert from "node:assert/strict";
import { validateCustom, queueCustomPost, POLL_DURATIONS } from "../services/dev-api-lambda/linkedin-custom.mjs";
import { publishRequest, publish } from "../services/linkedin-lambda/index.mjs";
import { formatOf, isPlannable } from "../services/dev-api-lambda/publishing-formats.mjs";

const NOW = new Date("2026-11-02T15:00:00Z");
const WHEN = "2026-11-03T14:00:00Z";
const PAGE = "urn:li:organization:123456";
const ROOT = "/1---elettro-brand-os/brands/elettro/";
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });
const ASSET = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("text, link and poll are LinkedIn formats written by hand, never planned", () => {
  for (const placement of ["text", "link", "poll"]) {
    const f = formatOf("linkedin", placement);
    assert.ok(f, placement);
    assert.equal(isPlannable(f), false);
  }
});

test("a text post needs text within 3,000 characters and a sensible time", () => {
  assert.equal(validateCustom({ kind: "text", text: "  Hello page  ", scheduledFor: WHEN }, NOW).text, "Hello page");
  assert.throws(() => validateCustom({ kind: "text", text: " ", scheduledFor: WHEN }, NOW), /Write the post text/);
  assert.throws(() => validateCustom({ kind: "text", text: "x".repeat(3001), scheduledFor: WHEN }, NOW), /3000/);
  assert.throws(() => validateCustom({ kind: "text", text: "hi", scheduledFor: "soon" }, NOW), /date and time/);
  assert.throws(() => validateCustom({ kind: "text", text: "hi", scheduledFor: "2026-01-01T00:00:00Z" }, NOW), /an hour ago to a year ahead/);
  assert.throws(() => validateCustom({ kind: "video", text: "hi", scheduledFor: WHEN }, NOW), /text, link or poll/);
});

test("a link post needs a real http(s) link and a title", () => {
  const ok = validateCustom({ kind: "link", text: "Read this", url: "https://elettro.com/blog/x", title: "A title", description: "Why", scheduledFor: WHEN }, NOW);
  assert.deepEqual(ok.custom, { kind: "link", url: "https://elettro.com/blog/x", title: "A title", description: "Why" });
  assert.throws(() => validateCustom({ kind: "link", url: "elettro.com", title: "t", scheduledFor: WHEN }, NOW), /starting with https/);
  assert.throws(() => validateCustom({ kind: "link", url: "javascript:alert(1)", title: "t", scheduledFor: WHEN }, NOW), /starting with https/);
  assert.throws(() => validateCustom({ kind: "link", url: "https://a.com", title: "", scheduledFor: WHEN }, NOW), /title/);
  assert.throws(() => validateCustom({ kind: "link", url: "https://a.com", title: "t", description: "d".repeat(256), scheduledFor: WHEN }, NOW), /255/);
});

test("a poll has a question up to 140, 2-4 different options up to 30, and a duration", () => {
  const ok = validateCustom({ kind: "poll", question: "Which?", options: ["A", " B ", ""], duration: "THREE_DAYS", scheduledFor: WHEN }, NOW);
  assert.deepEqual(ok.custom, { kind: "poll", question: "Which?", options: ["A", "B"], duration: "THREE_DAYS" });
  assert.equal(validateCustom({ kind: "poll", question: "Q", options: ["A", "B"], scheduledFor: WHEN }, NOW).custom.duration, "SEVEN_DAYS");
  assert.throws(() => validateCustom({ kind: "poll", question: "Q", options: ["A"], scheduledFor: WHEN }, NOW), /2 to 4/);
  assert.throws(() => validateCustom({ kind: "poll", question: "Q", options: ["a", "b", "c", "d", "e"], scheduledFor: WHEN }, NOW), /2 to 4/);
  assert.throws(() => validateCustom({ kind: "poll", question: "Q", options: ["A", "a"], scheduledFor: WHEN }, NOW), /different/);
  assert.throws(() => validateCustom({ kind: "poll", question: "Q", options: ["A", "x".repeat(31)], scheduledFor: WHEN }, NOW), /30/);
  assert.throws(() => validateCustom({ kind: "poll", question: "q".repeat(141), options: ["A", "B"], scheduledFor: WHEN }, NOW), /140/);
  assert.throws(() => validateCustom({ kind: "poll", question: "Q", options: ["A", "B"], duration: "TEN_DAYS", scheduledFor: WHEN }, NOW), /how long/);
  assert.deepEqual(POLL_DURATIONS, ["ONE_DAY", "THREE_DAYS", "SEVEN_DAYS", "FOURTEEN_DAYS"]);
});

function fakeClient({ account = { id: "sa1" }, carrier = { id: ASSET } } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes('FROM "SocialAccount"')) return { rows: account ? [account] : [] };
      if (sql.includes('FROM "Asset"')) return { rows: carrier ? [carrier] : [] };
      if (sql.includes('INSERT INTO "ScheduledPost"')) return { rows: [{ id: "new-post" }] };
      throw new Error("unexpected query");
    }
  };
}

test("queueing stores a planned post with the details and a carrier image", async () => {
  const client = fakeClient();
  const r = await queueCustomPost(client, { id: "b1" }, { kind: "poll", question: "Which?", options: ["A", "B"], text: "Vote", scheduledFor: WHEN }, NOW);
  assert.deepEqual([r.code, r.body.ok, r.body.status, r.body.id], [200, true, "planned", "new-post"]);
  const insert = client.seen.find((q) => q.sql.includes("INSERT"));
  assert.match(insert.sql, /'planned'/);
  assert.equal(insert.params[2], ASSET);
  assert.equal(insert.params[3], "poll");
  assert.deepEqual(JSON.parse(insert.params[6]), { manual: true, custom: { kind: "poll", question: "Which?", options: ["A", "B"], duration: "SEVEN_DAYS" } });
});

test("queueing refuses a brand with no connected LinkedIn page, or no image, or a bad request", async () => {
  const none = await queueCustomPost(fakeClient({ account: null }), { id: "b1" }, { kind: "text", text: "hi", scheduledFor: WHEN }, NOW);
  assert.deepEqual([none.code, /Connect this brand's LinkedIn page/.test(none.body.error)], [409, true]);
  const noImage = await queueCustomPost(fakeClient({ carrier: null }), { id: "b1" }, { kind: "text", text: "hi", scheduledFor: WHEN }, NOW);
  assert.deepEqual([noImage.code, /at least one approved image/.test(noImage.body.error)], [404, true]);
  const bad = await queueCustomPost(fakeClient(), { id: "b1" }, { kind: "text", text: "", scheduledFor: WHEN }, NOW);
  assert.equal(bad.code, 400);
  const badAsset = await queueCustomPost(fakeClient(), { id: "b1" }, { kind: "text", text: "hi", scheduledFor: WHEN, assetId: "nope" }, NOW);
  assert.equal(badAsset.code, 400);
});

// ---- worker ----

const claimed = (placement, custom, over = {}) => ({
  id: "p1", placement, caption: "Words", hashtags: [], dropboxPath: ROOT + "thumb.jpg", channelId: PAGE, custom, ...over
});

test("the worker checks a claimed text, poll or link post before anything goes out", () => {
  assert.equal(publishRequest(claimed("text", { kind: "text" })).kind, "text");
  assert.throws(() => publishRequest(claimed("text", { kind: "text" }, { caption: "" })), /no caption/);
  assert.throws(() => publishRequest(claimed("text", null)), /no text, link or poll details/);
  assert.throws(() => publishRequest(claimed("poll", { kind: "text" })), /no text, link or poll details/);
  const poll = { kind: "poll", question: "Q?", options: ["A", "B"], duration: "ONE_DAY" };
  assert.equal(publishRequest(claimed("poll", poll)).question, "Q?");
  assert.throws(() => publishRequest(claimed("poll", { ...poll, options: ["A"] })), /2 to 4 options/);
  assert.throws(() => publishRequest(claimed("poll", { ...poll, duration: "NEVER" })), /valid duration/);
  const link = { kind: "link", url: "https://elettro.com/x", title: "T", description: "D" };
  assert.equal(publishRequest(claimed("link", link)).source, "https://elettro.com/x");
  assert.throws(() => publishRequest(claimed("link", { ...link, url: "ftp://x" })), /valid link/);
  assert.throws(() => publishRequest(claimed("link", { ...link, title: " " })), /no title/);
  assert.throws(() => publishRequest(claimed("link", link, { dropboxPath: "/other/x.jpg" })), /inside/);
  assert.throws(() => publishRequest(claimed("text", { kind: "text" }, { channelId: "nope" })), /member id or page id/);
});

function recorder() {
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    return { status: 201, headers: headers({ "x-restli-id": "urn:li:share:9" }), body: {} };
  };
  return { calls, call };
}

test("a text post is created with the page as author and no content", async () => {
  const { calls, call } = recorder();
  const out = await publish({ accessToken: "t" }, claimed("text", { kind: "text" }), { call });
  assert.equal(out.postId, "urn:li:share:9");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.author, PAGE);
  assert.equal(calls[0].body.commentary, "Words");
  assert.ok(!("content" in calls[0].body));
});

test("a poll is created with its question, options and duration", async () => {
  const { calls, call } = recorder();
  await publish({ accessToken: "t" }, claimed("poll", { kind: "poll", question: "Which?", options: ["A", "B", "C"], duration: "FOURTEEN_DAYS" }), { call });
  assert.deepEqual(calls[0].body.content, { poll: { question: "Which?", options: [{ text: "A" }, { text: "B" }, { text: "C" }], settings: { duration: "FOURTEEN_DAYS" } } });
});

test("a link post uploads its thumbnail first and posts the article card", async () => {
  const { calls, call } = recorder();
  const seen = [];
  const upload = { image: async (record, request) => { seen.push(request); return "urn:li:image:THUMB"; } };
  await publish({ accessToken: "t" }, claimed("link", { kind: "link", url: "https://elettro.com/x", title: "A title", description: "Why" }), { call, upload });
  assert.equal(seen[0].channelId, PAGE);
  assert.equal(seen[0].dropboxPath, ROOT + "thumb.jpg");
  assert.deepEqual(calls[0].body.content, { article: { source: "https://elettro.com/x", thumbnail: "urn:li:image:THUMB", title: "A title", description: "Why" } });
});
