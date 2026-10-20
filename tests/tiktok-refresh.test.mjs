import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, handler } from "../services/tiktok-lambda/index.mjs";

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
  assert.equal((await handler({ action: "post" })).statusCode, 400);
});
