import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, refreshAll, handler, postRequest, postText, requestFromPost, account, publish, threads } from "../services/threads-lambda/index.mjs";
import { setTokenExpiry } from "../services/dev-api-lambda/connection-status.mjs";

const NOW = new Date("2026-11-20T00:00:00Z");
// Shaped like the secret threads-connect stores.
const record = {
  accessToken: "old", userId: "29725971673672893", username: "stashboxmusic", brand: "stashbox",
  expiresAt: "2026-12-19T14:10:00.000Z", connectedAt: "2026-10-20T14:10:00.000Z"
};
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
const json = (statusCode, body) => ({ statusCode, body });

test("tokens are renewed inside the last 30 days, never when under 24 hours old or already expired", () => {
  assert.equal(needsRefresh(record, NOW), true);
  assert.equal(needsRefresh(record, new Date("2026-10-25T00:00:00Z")), false);
  assert.equal(needsRefresh({ ...record, refreshedAt: "2026-11-19T12:00:00.000Z" }, NOW), false);
  assert.equal(needsRefresh(record, new Date("2026-12-20T00:00:00Z")), false);
  assert.equal(needsRefresh({ ...record, expiresAt: undefined }, NOW), true);
});

test("a refresh calls th_refresh_token and stores a new 60-day token", async () => {
  let asked;
  const get = async (url) => { asked = url; return reply(200, { access_token: "new", token_type: "bearer", expires_in: 5184000 })(); };
  const next = await refreshRecord(record, NOW, get);
  assert.equal(asked.origin + asked.pathname, "https://graph.threads.net/refresh_access_token");
  assert.equal(asked.searchParams.get("grant_type"), "th_refresh_token");
  assert.equal(asked.searchParams.get("access_token"), "old");
  assert.equal(next.accessToken, "new");
  assert.equal(next.expiresAt, "2027-01-19T00:00:00.000Z");
  assert.equal(next.refreshedAt, NOW.toISOString());
  assert.equal(next.username, "stashboxmusic");
});

test("Threads errors surface with their message", async () => {
  await assert.rejects(refreshRecord(record, NOW, reply(400, { error: { message: "Session has expired" } })),
    /Threads refresh failed: Session has expired/);
  await assert.rejects(refreshRecord({ ...record, accessToken: "" }, NOW), /no access token/);
});

test("a renewal is saved, then moves the countdown; one failing account doesn't stop the others", async () => {
  const store = {
    "elettro-brand-os-dev/threads/1": record,
    "elettro-brand-os-dev/threads/2": { ...record, userId: "2", username: "therasbox", accessToken: "revoked" },
    "elettro-brand-os-dev/threads/3": { ...record, userId: "3", username: "fresh", expiresAt: "2027-01-10T00:00:00.000Z" }
  };
  const writes = [], calls = [];
  const out = await refreshAll(NOW, {
    names: async () => Object.keys(store),
    read: async (id) => store[id],
    write: async (id, next) => writes.push([id, next.accessToken]),
    refresh: async (r, now) => { if (r.accessToken === "revoked") throw new Error("Threads refresh failed: 190"); return { ...r, accessToken: "new", expiresAt: "2027-01-19T00:00:00.000Z", refreshedAt: now.toISOString() }; },
    callApi: async (payload) => { calls.push(payload); return { ok: true }; }
  });
  assert.deepEqual(writes, [["elettro-brand-os-dev/threads/1", "new"]]);
  assert.deepEqual(calls, [{ action: "set-token-expiry", destination: "threads", externalAccountId: "29725971673672893", tokenExpiresAt: "2027-01-19T00:00:00.000Z" }]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.accounts.map((a) => [a.handle, a.refreshed, Boolean(a.error)]),
    [["@stashboxmusic", true, false], ["@therasbox", false, true], ["@fresh", false, false]]);
});

test("a countdown update that fails is reported but the renewal still counts", async () => {
  const out = await refreshAll(NOW, {
    names: async () => ["elettro-brand-os-dev/threads/1"], read: async () => record, write: async () => {},
    refresh: async (r) => ({ ...r, accessToken: "new", expiresAt: "2027-01-19T00:00:00.000Z" }),
    callApi: async () => { throw new Error("set-token-expiry crashed"); }
  });
  assert.equal(out.ok, true);
  assert.equal(out.accounts[0].refreshed, true);
  assert.match(out.accounts[0].countdownError, /crashed/);
});

test("the worker refuses HTTP events and unknown actions", async () => {
  assert.equal((await handler({ rawPath: "/x" })).statusCode, 403);
  assert.equal((await handler({ action: "post" })).statusCode, 400);
});

test("set-token-expiry checks its input and moves the account's expiry", async () => {
  const noDatabase = async () => { throw new Error("database should not be reached"); };
  assert.equal((await setTokenExpiry({ destination: "myspace", externalAccountId: "1", tokenExpiresAt: "2027-01-19" }, noDatabase, json)).statusCode, 400);
  assert.equal((await setTokenExpiry({ destination: "threads", externalAccountId: "1", tokenExpiresAt: "soon" }, noDatabase, json)).statusCode, 400);
  const queries = [];
  const client = { async query(sql, params) { queries.push([sql, params]); return { rows: sql.startsWith("UPDATE") ? [{ id: "sa-1" }] : [] }; }, async end() {} };
  const r = await setTokenExpiry({ destination: "threads", externalAccountId: "29725971673672893", tokenExpiresAt: "2027-01-19T00:00:00.000Z" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  const update = queries.find(([sql]) => sql.startsWith("UPDATE"));
  assert.deepEqual(update[1].slice(0, 2), ["threads", "29725971673672893"]);
  assert.equal(update[1][2].toISOString(), "2027-01-19T00:00:00.000Z");
});

// ---- Publishing ----

const clip = "/1---elettro-brand-os/brands/stashbox/band/video/9x16/music-video/angel-in-your-bed/clip.mp4";

test("a post request is text, image or video, inside the brands root, within 500 characters", () => {
  assert.deepEqual(postRequest({ brand: "stashbox", text: "Hello" }), { brand: "stashbox", text: "Hello", dropboxPath: null, mediaType: "TEXT" });
  assert.equal(postRequest({ brand: "stashbox", dropboxPath: clip }).mediaType, "VIDEO");
  assert.equal(postRequest({ brand: "stashbox", dropboxPath: clip.replace(".mp4", ".JPG") }).mediaType, "IMAGE");
  assert.throws(() => postRequest({ brand: "stashbox" }), /needs text/);
  assert.throws(() => postRequest({ brand: "stashbox", text: "x".repeat(501) }), /500/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: "/Personal/clip.mp4" }), /brands/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: clip.replace(".mp4", ".gif") }), /video or a .jpg/);
  assert.throws(() => postRequest({ brand: "Stash Box", text: "x" }), /brand/);
});

test("planner captions keep one hashtag and stay within 500 characters", () => {
  assert.equal(postText("Live at Studio One.", ["#stashbox", "#dylan"]), "Live at Studio One.\n\n#stashbox");
  assert.equal(postText("Live.", []), "Live.");
  assert.equal(postText("x".repeat(495), ["stashbox"]), "x".repeat(495));
  assert.equal(postText("x".repeat(600), []).length, 500);
  const r = requestFromPost({ caption: "Tangled Up in Blue, live.", hashtags: ["#stashbox"], channelId: "29725971673672893", dropboxPath: clip });
  assert.deepEqual([r.mediaType, r.userId, r.text], ["VIDEO", "29725971673672893", "Tangled Up in Blue, live.\n\n#stashbox"]);
});

test("the account is found by brand or Threads user id; expired or missing logins say so", async () => {
  const store = { "elettro-brand-os-dev/threads/1": { ...record, userId: "1" }, "elettro-brand-os-dev/threads/2": { ...record, userId: "2", brand: "therasbox", username: "therasbox" } };
  const deps = { names: async () => Object.keys(store), read: async (id) => store[id], now: NOW };
  assert.equal((await account("therasbox", null, deps)).userId, "2");
  assert.equal((await account(null, "1", deps)).brand, "stashbox");
  await assert.rejects(account("solarmeister", null, deps), /No Threads account is connected for solarmeister/);
  await assert.rejects(account(null, "1", { ...deps, now: new Date("2027-01-01T00:00:00Z") }), /expired; reconnect/);
});

test("a video post creates a container from a Dropbox link, waits for FINISHED, publishes and reads the permalink", async () => {
  const calls = [];
  let polls = 0;
  const call = async (path, opts = {}) => {
    calls.push([path, opts.method || "GET", opts.params]);
    if (path === "29725971673672893/threads") return { id: "c1" };
    if (path === "c1") return { status: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" };
    if (path === "29725971673672893/threads_publish") return { id: "p1" };
    if (path === "p1") return { permalink: "https://www.threads.com/@stashboxmusic/post/abc" };
    throw new Error("unexpected " + path);
  };
  const out = await publish(record, { mediaType: "VIDEO", text: "Live.", dropboxPath: clip },
    { call, link: async () => "https://dl.dropboxusercontent.com/x.mp4", wait: async () => {}, pollMs: 1, limitMs: 100 });
  assert.deepEqual(out, { postId: "p1", permalink: "https://www.threads.com/@stashboxmusic/post/abc", handle: "@stashboxmusic" });
  assert.deepEqual(calls[0], ["29725971673672893/threads", "POST", { media_type: "VIDEO", text: "Live.", video_url: "https://dl.dropboxusercontent.com/x.mp4" }]);
  assert.deepEqual(calls.find(([p]) => p.endsWith("threads_publish"))[2], { creation_id: "c1" });
  assert.equal(polls, 3);
});

test("a text post needs no Dropbox link; processing errors and timeouts fail the post before publishing", async () => {
  const published = [];
  const make = (status) => async (path, opts = {}) => {
    if (path.endsWith("/threads")) return { id: "c1", params: opts.params };
    if (path === "c1") return { status, error_message: "Video too long" };
    if (path.endsWith("threads_publish")) { published.push(path); return { id: "p1" }; }
    return {};
  };
  const noLink = async () => { throw new Error("no Dropbox for text"); };
  const text = await publish(record, { mediaType: "TEXT", text: "Question for you." }, { call: make("FINISHED"), link: noLink, wait: async () => {} });
  assert.equal(text.postId, "p1");
  assert.equal(text.permalink, null);
  published.length = 0;
  await assert.rejects(publish(record, { mediaType: "VIDEO", text: "", dropboxPath: clip }, { call: make("ERROR"), link: async () => "u", wait: async () => {} }),
    /could not process the media: Video too long/);
  await assert.rejects(publish(record, { mediaType: "VIDEO", text: "", dropboxPath: clip }, { call: make("IN_PROGRESS"), link: async () => "u", wait: async () => {}, pollMs: 10, limitMs: 30 }),
    /still processing/);
  assert.deepEqual(published, []);
});

test("Graph calls send the token, use POST bodies for writes, and surface Threads error messages", async () => {
  let seen;
  const ok = async (url, init) => { seen = { url: String(url), init }; return { ok: true, json: async () => ({ id: "c1" }) }; };
  await threads("123/threads", "tok", { method: "POST", params: { media_type: "TEXT", text: "Hi" } }, ok);
  assert.equal(seen.url, "https://graph.threads.net/v1.0/123/threads");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(Object.fromEntries(seen.init.body), { media_type: "TEXT", text: "Hi", access_token: "tok" });
  await threads("c1", "tok", { params: { fields: "status" } }, ok);
  assert.match(seen.url, /\/v1\.0\/c1\?fields=status&access_token=tok$/);
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid parameter" } }) });
  await assert.rejects(threads("123/threads_publish", "tok", { method: "POST" }, bad), /Threads threads_publish failed: Invalid parameter/);
});

test("post requests with bad input are refused before anything is sent", async () => {
  assert.equal((await handler({ action: "post", brand: "stashbox" })).statusCode, 400);
});
