import test from "node:test";
import assert from "node:assert/strict";
import { postText, complianceProblems, requestFromPost, postRequest, uploadMedia, publish, publishingTick, account, MAX_TEXT } from "../services/mastodon-lambda/index.mjs";

const REC = { accessToken: "tok", instance: "mastodon.social", acct: "stashboxcom", accountId: "1", brand: "stashbox" };
const PATH = "/1---elettro-brand-os/brands/stashbox/a.jpg";
const post = (over = {}) => ({ id: "p1", placement: "post", caption: "Hello", hashtags: ["a", "b"], channelId: "1@mastodon.social", dropboxPath: PATH, ...over });
const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("postText adds up to three tags and never passes 500 characters", () => {
  assert.equal(postText("Hi", ["a", "#b c", "d", "e"]), "Hi\n\n#a #bc #d");
  const long = postText("x".repeat(600), ["tag"]);
  assert.ok([...long].length <= MAX_TEXT && long.endsWith("#tag"));
});

test("scheduled posts may not @mention accounts", () => {
  assert.equal(complianceProblems("see @someone@mastodon.social").length, 1);
  assert.equal(complianceProblems("see @someone").length, 1);
  assert.equal(complianceProblems("a plain post with a link https://stashbox.com").length, 0);
  assert.throws(() => requestFromPost(post({ caption: "hi @friend@mastodon.social" })), /mention/);
});

test("requests: photo, multi-photo and video; slide counts and file types are checked", () => {
  assert.equal(requestFromPost(post()).kind, "images");
  const car = requestFromPost(post({ placement: "carousel", slides: [{ dropboxPath: PATH }, { dropboxPath: PATH.replace("a.", "b.") }] }));
  assert.equal(car.paths.length, 2);
  assert.throws(() => requestFromPost(post({ placement: "carousel", slides: [{ dropboxPath: PATH }] })), /needs 2-4/);
  assert.throws(() => requestFromPost(post({ placement: "carousel", slides: Array(5).fill({ dropboxPath: PATH }) })), /needs 2-4/);
  assert.equal(requestFromPost(post({ placement: "video", dropboxPath: PATH.replace("a.jpg", "v.mp4") })).kind, "video");
  assert.throws(() => requestFromPost(post({ placement: "video" })), /\.mp4/);
  assert.throws(() => requestFromPost(post({ channelId: "" })), /not linked/);
  assert.throws(() => requestFromPost(post({ dropboxPath: "/elsewhere/a.jpg" })), /inside/);
  assert.equal(requestFromPost(post()).idempotencyKey, "elettro-os-p1");
});

test("manual posts: text only, images, or one video", () => {
  assert.equal(postRequest({ brand: "stashbox", text: "hi" }).kind, "text");
  assert.throws(() => postRequest({ brand: "stashbox", text: "x".repeat(501) }), /500/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPaths: [PATH, PATH.replace("a.jpg", "v.mp4")] }), /not both/);
});

test("uploadMedia sends the file with alt text, and waits for a video the instance is still processing", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    if (init.method === "POST") return jsonResponse(202, { id: "m1", url: null });
    return calls.filter((c) => c.method === "GET").length < 2 ? jsonResponse(206, { id: "m1", url: null }) : jsonResponse(200, { id: "m1", url: "https://x/m1.mp4" });
  };
  const id = await uploadMedia(REC, Buffer.from("v"), "v.mp4", "/x/v.mp4", "alt", { fetchImpl, wait: async () => {}, pollMs: 1 });
  assert.equal(id, "m1");
  assert.equal(calls[0].url, "https://mastodon.social/api/v2/media");
  assert.equal(calls[0].auth, "Bearer tok");
  assert.equal(calls.filter((c) => c.method === "GET").length, 2);
});

test("uploadMedia refuses files over the instance limits and reports a revoked login", async () => {
  await assert.rejects(uploadMedia(REC, Buffer.alloc(100 * 1024 * 1024), "v.mp4", "/x/v.mp4", "", { fetchImpl: async () => { throw new Error("no"); } }), /99 MB/);
  await assert.rejects(uploadMedia(REC, Buffer.from("i"), "a.jpg", "/x/a.jpg", "", { fetchImpl: async () => jsonResponse(401, {}) }), /reconnect/);
});

test("publish uploads the media, then creates one public status with an idempotency key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v2/media")) return jsonResponse(200, { id: "m" + calls.length, url: "u" });
    return jsonResponse(200, { id: "99", url: "https://mastodon.social/@stashboxcom/99" });
  };
  const out = await publish(REC, { text: "Hi", paths: [PATH, PATH], alt: "a", idempotencyKey: "k1" }, { download: async () => Buffer.from("i"), fetchImpl });
  assert.equal(out.url, "https://mastodon.social/@stashboxcom/99");
  const status = calls.find((c) => c.url.endsWith("/api/v1/statuses"));
  const body = JSON.parse(status.init.body);
  assert.deepEqual([body.visibility, body.media_ids.length, status.init.headers["idempotency-key"]], ["public", 2, "k1"]);
});

test("the tick claims only Mastodon placements, publishes, and reports success or failure to the planner", async () => {
  const sent = [];
  const callApi = async (p) => {
    sent.push(p);
    if (p.action === "claim-due-posts") return { ok: true, posts: [post({ id: "good" }), post({ id: "bad", caption: "hi @x@y.social" })] };
    return { ok: true };
  };
  const out = await publishingTick({ callApi, find: async () => REC, send: async () => ({ id: "5", url: "https://m/5" }) });
  const claim = sent.find((p) => p.action === "claim-due-posts");
  assert.deepEqual([claim.destination, claim.placements], ["mastodon", ["post", "carousel", "video"]]);
  const finishes = sent.filter((p) => p.action === "finish-post");
  assert.equal(finishes.find((p) => p.id === "good").externalUrl, "https://m/5");
  assert.match(finishes.find((p) => p.id === "bad").error, /mention/);
  assert.equal(out.published.length, 2);
});

test("account reads the stored login for the post's account key, and refuses a missing or revoked one", async () => {
  assert.equal((await account(null, "1@mastodon.social", { read: async () => REC })).accessToken, "tok");
  await assert.rejects(account(null, "1@mastodon.social", { read: async () => ({ revokedAt: "x", accessToken: "t" }) }), /reconnect/);
  assert.equal((await account("stashbox", null, { names: async () => ["n"], read: async () => REC })).acct, "stashboxcom");
});
