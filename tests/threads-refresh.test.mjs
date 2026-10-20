import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, refreshAll, handler } from "../services/threads-lambda/index.mjs";
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
