import test from "node:test";
import assert from "node:assert/strict";
import { stripUrls, hasUrl, postText, weight, complianceProblems, requestFromPost, postRequest, account, uploadImage, uploadVideo, publish, publishingTick, MAX_TEXT, CHUNK_BYTES, VIDEO_BYTE_LIMIT } from "../services/x-lambda/index.mjs";

const REC = { accessToken: "tok", username: "stashboxmusic", accountId: "42" };
const PATH = "/1---elettro-brand-os/brands/stashbox/a.jpg";
const post = (over = {}) => ({ id: "p1", placement: "post", caption: "Hello", hashtags: ["a", "b", "c"], channelId: "42", dropboxPath: PATH, ...over });
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("a link weighs 23 characters; postText keeps up to two tags within 280", () => {
  assert.equal(weight("see https://example.com/a/very/long/path/that/goes/on"), 4 + 23);
  assert.equal(postText("Hi", ["a", "#b c", "d"]), "Hi\n\n#a #bc");
  const long = postText("word ".repeat(100), ["tag"]);
  assert.ok(weight(long) <= MAX_TEXT && long.endsWith("#tag"));
});

test("scheduled posts may not @mention accounts", () => {
  assert.equal(complianceProblems("thanks @someone").length, 1);
  assert.equal(complianceProblems("mail dean@elettro.com or visit https://stashbox.com").length, 0);
  assert.throws(() => requestFromPost(post({ caption: "hi @friend" })), /mention/);
});

test("requests: photo and multi-photo; counts, types, paths and account are checked", () => {
  assert.deepEqual(requestFromPost(post()).paths, [PATH]);
  assert.equal(requestFromPost(post({ placement: "carousel", slides: [{ dropboxPath: PATH }, { dropboxPath: PATH.replace("a.", "b.") }] })).paths.length, 2);
  assert.throws(() => requestFromPost(post({ placement: "carousel", slides: [{ dropboxPath: PATH }] })), /needs 2-4/);
  assert.throws(() => requestFromPost(post({ dropboxPath: PATH.replace("a.jpg", "v.mp4") })), /photo post/);
  assert.equal(requestFromPost(post({ placement: "video", dropboxPath: PATH.replace("a.jpg", "v.mp4") })).kind, "video");
  assert.throws(() => requestFromPost(post({ placement: "video" })), /\.mp4/);
  assert.throws(() => requestFromPost(post({ channelId: "" })), /not linked/);
  assert.throws(() => requestFromPost(post({ dropboxPath: "/elsewhere/a.jpg" })), /inside/);
});

test("manual posts: text or images, needs a brand or account key", () => {
  assert.equal(postRequest({ brand: "stashbox", text: "hi" }).paths.length, 0);
  assert.throws(() => postRequest({ text: "hi" }), /brand slug/);
  assert.throws(() => postRequest({ brand: "stashbox", text: "x".repeat(281) }), /280/);
  assert.equal(postRequest({ brand: "stashbox", dropboxPath: PATH.replace("a.jpg", "v.mp4") }).kind, "video");
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPaths: [PATH, PATH.replace("a.jpg", "v.mp4")] }), /not both/);
});

test("account: a fresh token is reused; an old one is refreshed and the rotated pair is written back", async () => {
  const now = () => Date.parse("2026-11-06T12:00:00Z");
  const fresh = { accessToken: "a", refreshToken: "r", expiresAt: "2026-11-06T13:00:00Z", username: "u" };
  let wrote = null;
  assert.equal((await account("42", { read: async () => fresh, write: async () => { wrote = 1; }, now })).accessToken, "a");
  assert.equal(wrote, null);
  const old = { ...fresh, expiresAt: "2026-11-06T11:00:00Z" };
  let calls = 0;
  const read = async (n) => (n.endsWith("x-oauth") ? { clientId: "id", clientSecret: "sec" } : old);
  const fetchImpl = async (url, init) => { calls++; assert.match(String(init.body), /grant_type=refresh_token/); assert.match(init.headers.authorization, /^Basic /); return res(200, { access_token: "new", refresh_token: "r2", expires_in: 7200 }); };
  const got = await account("42", { read, write: async (id, v) => { wrote = { id, v }; }, fetchImpl, now });
  assert.equal(got.accessToken, "new");
  assert.equal(wrote.id, "elettro-brand-os-dev/x/42");
  assert.equal(wrote.v.refreshToken, "r2");
  assert.equal(calls, 1);
});

test("account: a refused refresh asks for a reconnect and writes nothing", async () => {
  const old = { accessToken: "a", refreshToken: "r", expiresAt: "2020-01-01T00:00:00Z", username: "u" };
  const read = async (n) => (n.endsWith("x-oauth") ? { clientId: "id", clientSecret: "s" } : old);
  await assert.rejects(account("42", { read, write: async () => assert.fail("must not write"), fetchImpl: async () => res(400, { error: "invalid_request" }) }), /reconnect/);
});

test("publish uploads each image then creates one post with the media ids", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url.endsWith("/2/media/upload")) return res(200, { data: { id: "m" + seen.length } });
    if (url.endsWith("/2/media/metadata")) return res(200, {});
    return res(201, { data: { id: "999" } });
  };
  const out = await publish(REC, { text: "Hi", paths: [PATH, PATH], alt: "pic" }, { download: async () => Buffer.from("x"), fetchImpl });
  assert.equal(out.url, "https://x.com/stashboxmusic/status/999");
  assert.equal(seen.filter((u) => u.endsWith("/2/tweets")).length, 1);
});

test("big images, expired logins and an empty credit balance fail with a clear message", async () => {
  await assert.rejects(uploadImage(REC, Buffer.alloc(6 * 1024 * 1024), "a.jpg", "a.jpg", ""), /5 MB/);
  await assert.rejects(publish(REC, { text: "Hi", paths: [] }, { fetchImpl: async () => res(401, {}) }), /reconnect/);
  await assert.rejects(publish(REC, { text: "Hi", paths: [] }, { fetchImpl: async () => res(402, {}) }), /credits/);
});

test("the tick claims x posts, publishes, and reports each result (one bad post does not stop the loop)", async () => {
  const finished = [];
  const callApi = async (p) => {
    if (p.action === "claim-due-posts") { assert.equal(p.destination, "x"); return { ok: true, posts: [post({ id: "good" }), post({ id: "bad", channelId: "" })], missed: 0, stuck: 0 }; }
    finished.push(p); return { ok: true };
  };
  const out = await publishingTick({ callApi, find: async () => REC, send: async () => ({ id: "7", url: "https://x.com/u/status/7" }) });
  assert.equal(out.published.length, 2);
  assert.equal(finished[0].externalPostId, "7");
  assert.match(finished[1].error, /not linked/);
});

const memorySource = (size) => ({ size, read: async (a, b) => Buffer.alloc(b - a, 1) });

test("video: initialize, append in 4 MiB parts in order, finalize, then poll until processed", async () => {
  const calls = [];
  const size = CHUNK_BYTES * 2 + 100; // three parts
  let polls = 0;
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://api.x.com", "")}`);
    if (url.endsWith("/initialize")) { assert.deepEqual(JSON.parse(init.body), { media_type: "video/mp4", total_bytes: size, media_category: "tweet_video" }); return res(200, { data: { id: "v1" } }); }
    if (url.includes("/append")) return res(204, {});
    if (url.endsWith("/finalize")) return res(200, { data: { id: "v1", processing_info: { state: "pending", check_after_secs: 1 } } });
    polls += 1;
    return res(200, { data: { processing_info: polls < 2 ? { state: "in_progress", check_after_secs: 1 } : { state: "succeeded" } } });
  };
  const id = await uploadVideo(REC, PATH.replace("a.jpg", "v.mp4"), { fetchImpl, source: async () => memorySource(size), wait: async () => {} });
  assert.equal(id, "v1");
  assert.deepEqual(calls.filter((c) => c.includes("/append")).length, 3);
  assert.equal(calls[0], "POST /2/media/upload/initialize");
  assert.ok(calls.at(-1).startsWith("GET /2/media/upload?command=STATUS&media_id=v1"));
  assert.equal(polls, 2);
});

test("video: a failed processing, a stuck one and a too-big file each stop with a clear message", async () => {
  const base = (info) => async (url) => url.endsWith("/initialize") ? res(200, { data: { id: "v" } }) : url.includes("/append") ? res(204, {}) : url.endsWith("/finalize") ? res(200, { data: { processing_info: info } }) : res(200, { data: { processing_info: info } });
  const src = async () => memorySource(1000);
  await assert.rejects(uploadVideo(REC, "v.mp4", { fetchImpl: base({ state: "failed", error: { message: "bad codec" } }), source: src, wait: async () => {} }), /bad codec/);
  await assert.rejects(uploadVideo(REC, "v.mp4", { fetchImpl: base({ state: "in_progress", check_after_secs: 10 }), source: src, wait: async () => {}, limitMs: 25_000 }), /still processing/);
  await assert.rejects(uploadVideo(REC, "v.mp4", { fetchImpl: base({}), source: async () => memorySource(VIDEO_BYTE_LIMIT + 1) }), /up to 1024 MB/);
});

test("publish with a video posts once with the processed media id", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url.endsWith("/initialize")) return res(200, { data: { id: "vv" } });
    if (url.includes("/append")) return res(204, {});
    if (url.endsWith("/finalize")) return res(200, { data: { id: "vv" } });
    assert.deepEqual(JSON.parse(init.body).media, { media_ids: ["vv"] });
    return res(201, { data: { id: "555" } });
  };
  const out = await publish(REC, { text: "Clip", paths: [PATH.replace("a.jpg", "v.mp4")], kind: "video" }, { fetchImpl, source: async () => memorySource(10) });
  assert.equal(out.url, "https://x.com/stashboxmusic/status/555");
});

test("NO URL POSTS: scheduled text is stripped of every link and domain, manual text with one is refused", async () => {
  assert.equal(stripUrls("Listen now https://stashbox.com/radio today"), "Listen now today");
  assert.equal(stripUrls("Visit www.elettro.com or stashbox.com/radio!"), "Visit or");
  assert.equal(postText("New show at https://stashbox.com", ["live"]), "New show at\n\n#live");
  assert.ok(!hasUrl("Great night, see you there #stashbox @stashboxmusic"));
  assert.ok(hasUrl("book at elettro.com") && hasUrl("http://x.co/a") && hasUrl("www.a.io"));
  assert.equal(requestFromPost(post({ caption: "Tune in https://stashbox.com/radio" })).text.includes("http"), false);
  assert.throws(() => postRequest({ brand: "stashbox", text: "hi https://stashbox.com" }), /URL/);
  assert.equal(stripUrls("Reggae.Land opens soon"), "opens soon");
  await assert.rejects(publish(REC, { text: "Tune in stashbox.com", paths: [] }, { fetchImpl: async () => res(200, { data: { id: "1" } }) }), /no URL posts/);
  assert.equal(requestFromPost(post({ altText: "Poster, see stashbox.com/radio" })).alt, "Poster, see");
});
