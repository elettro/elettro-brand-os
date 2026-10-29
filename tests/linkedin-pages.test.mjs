import test from "node:test";
import assert from "node:assert/strict";
import { publishRequest, account, hasValidLogin, secretKeyFor, renewRecord, publish } from "../services/linkedin-lambda/index.mjs";
import { completeLinkedinConnect } from "../services/dev-api-lambda/linkedin-connect.mjs";

const ROOT = "/1---elettro-brand-os/brands/elettro/";
const NOW = new Date("2026-11-01T00:00:00Z");
const ORG = "urn:li:organization:123456";
const day = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const page = (over = {}) => ({
  accessToken: "page-token", refreshToken: "refresh-1", brand: "elettro", expiresAt: day(30), refreshExpiresAt: day(300), ...over
});
const post = (over = {}) => ({ id: "p1", placement: "post", caption: "Hello.", hashtags: [], dropboxPath: ROOT + "pic.jpg", channelId: ORG, ...over });
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

test("a company page can be the author of a post", () => {
  assert.equal(publishRequest(post()).channelId, ORG);
  assert.throws(() => publishRequest(post({ channelId: "urn:li:organization:abc" })), /member id or page id/);
  assert.throws(() => publishRequest(post({ channelId: "urn:li:company:123456" })), /member id or page id/);
});

test("page tokens are stored under org-<id>, member tokens under their id", () => {
  assert.equal(secretKeyFor(ORG), "org-123456");
  assert.equal(secretKeyFor("urn:li:person:abc123XYZ"), "abc123XYZ");
  assert.throws(() => secretKeyFor("urn:li:organization:"), /member id/);
});

test("a page login with plenty of time left is used as is", async () => {
  const read = async (id) => { assert.ok(id.endsWith("/org-123456")); return page(); };
  const renew = async () => { throw new Error("must not renew"); };
  assert.equal((await account(ORG, { read, now: NOW, renew })).accessToken, "page-token");
});

test("a page login within 7 days of expiring is renewed, stored, and its reconnect date moved", async () => {
  const saved = []; const calls = [];
  const next = await account(ORG, {
    read: async () => page({ expiresAt: day(3) }), now: NOW,
    renew: async (record) => ({ ...record, accessToken: "page-token-2", expiresAt: day(60) }),
    save: async (id, value) => saved.push([id, value]),
    callApi: async (payload) => { calls.push(payload); return { ok: true }; }
  });
  assert.equal(next.accessToken, "page-token-2");
  assert.equal(saved.length, 1);
  assert.ok(saved[0][0].endsWith("/org-123456"));
  assert.deepEqual(calls, [{ action: "set-token-expiry", destination: "linkedin", externalAccountId: ORG, tokenExpiresAt: day(300) }]);
});

test("an expired page login with a live refresh token is renewed instead of failing", async () => {
  const next = await account(ORG, {
    read: async () => page({ expiresAt: day(-1) }), now: NOW,
    renew: async (record) => ({ ...record, accessToken: "fresh", expiresAt: day(60) }),
    save: async () => {}, callApi: async () => ({ ok: true })
  });
  assert.equal(next.accessToken, "fresh");
});

test("a failed renewal keeps using a login that has not expired yet, but not an expired one", async () => {
  const renew = async () => { throw new Error("LinkedIn said no"); };
  const still = await account(ORG, { read: async () => page({ expiresAt: day(3) }), now: NOW, renew, save: async () => {}, callApi: async () => ({}) });
  assert.equal(still.accessToken, "page-token");
  await assert.rejects(account(ORG, { read: async () => page({ expiresAt: day(-1) }), now: NOW, renew, save: async () => {}, callApi: async () => ({}) }), /LinkedIn said no/);
});

test("a member login (no refresh token) is never renewed and still expires", async () => {
  const member = { accessToken: "m", expiresAt: day(-1) };
  await assert.rejects(account("urn:li:person:abc123XYZ", { read: async () => member, now: NOW }), /expired/);
});

test("an expired page login with a live refresh token still counts as a usable login", async () => {
  const names = async () => ["a"];
  assert.equal(await hasValidLogin({ names, read: async () => page({ expiresAt: day(-1) }), now: NOW }), true);
  assert.equal(await hasValidLogin({ names, read: async () => page({ expiresAt: day(-1), refreshExpiresAt: day(-1) }), now: NOW }), false);
  assert.equal(await hasValidLogin({ names, read: async () => ({ accessToken: "m", expiresAt: day(-1) }), now: NOW }), false);
});

test("renewal sends the refresh grant and keeps the old refresh token unless LinkedIn rotates it", async () => {
  let sent;
  const call = async (url, init) => { sent = { url, body: String(init.body) }; return { ok: true, json: async () => ({ access_token: "new", expires_in: 5184000 }) }; };
  const out = await renewRecord(page(), { appCredentials: async () => ({ clientId: "cid", clientSecret: "sec" }), call, now: NOW });
  assert.equal(sent.url, "https://www.linkedin.com/oauth/v2/accessToken");
  assert.match(sent.body, /grant_type=refresh_token/);
  assert.match(sent.body, /refresh_token=refresh-1/);
  assert.equal(out.accessToken, "new");
  assert.equal(out.expiresAt, day(60));
  assert.equal(out.refreshToken, "refresh-1");
  assert.equal(out.refreshExpiresAt, day(300));
  const rotating = async () => ({ ok: true, json: async () => ({ access_token: "n2", expires_in: 100, refresh_token: "refresh-2", refresh_token_expires_in: 86400 * 365 }) });
  const rotated = await renewRecord(page(), { appCredentials: async () => ({ clientId: "cid", clientSecret: "sec" }), call: rotating, now: NOW });
  assert.equal(rotated.refreshToken, "refresh-2");
  assert.equal(rotated.refreshExpiresAt, day(365));
});

test("renewal fails clearly when LinkedIn refuses or the app credentials are missing", async () => {
  const refuse = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "refresh token expired" }) });
  await assert.rejects(renewRecord(page(), { appCredentials: async () => ({ clientId: "c", clientSecret: "s" }), call: refuse, now: NOW }), /refresh token expired/);
  await assert.rejects(renewRecord(page(), { appCredentials: async () => ({}), now: NOW }), /credentials/);
});

test("a company-page post is created with the page as author and owner of the upload", async () => {
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/posts") return { status: 201, headers: headers({ "x-restli-id": "urn:li:share:1" }), body: {} };
    return { status: 200, headers: headers({}), body: {} };
  };
  const upload = { image: async (record, request) => { assert.equal(request.channelId, ORG); return "urn:li:image:9"; } };
  const out = await publish(page(), post(), { call, upload });
  assert.equal(out.postId, "urn:li:share:1");
  assert.equal(calls.find((c) => c.path === "/posts").body.author, ORG);
});

// ---- connect completion (dev-api) ----

const KEY = "k".repeat(40);
const json = (statusCode, body) => ({ statusCode, body });
const event = { headers: { "x-elettro-connect-key": KEY } };

test("page completion needs a numeric page id and a token before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const noDb = async () => { throw new Error("database should not be reached"); };
  assert.equal((await completeLinkedinConnect(event, { brand: "elettro", page: { id: "abc", name: "P" }, accessToken: "t" }, noDb, json, NOW)).statusCode, 400);
  assert.equal((await completeLinkedinConnect(event, { brand: "elettro", page: { id: "123456", name: "P" } }, noDb, json, NOW)).statusCode, 400);
});
