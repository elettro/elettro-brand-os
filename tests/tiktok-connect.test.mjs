import test from "node:test";
import assert from "node:assert/strict";
import { completeTiktokConnect } from "../services/dev-api-lambda/tiktok-connect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const user = { id: "-000AbCdEf_123456", username: "stashboxmusic", name: "Stashbox" };
const tokens = { accessToken: "a", refreshToken: "r", expiresIn: 86400, refreshExpiresIn: 31536000, scope: "user.info.basic,video.publish" };
const NOW = new Date("2026-10-20T00:00:00Z");

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeTiktokConnect({ headers: {} }, { brand: "stashbox", user, ...tokens }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, user or missing tokens before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeTiktokConnect(event, { brand: "stashbox", user, accessToken: "a" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeTiktokConnect(event, { brand: "stashbox", user: { id: "bad id!" }, ...tokens }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeTiktokConnect(event, { brand: "Stash Box", user, ...tokens }, noDatabase, json)).statusCode, 400);
});

test("a TikTok account links to the brand's tiktok row; reconnect date = refresh token expiry", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const writes = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [] };
      if (sql.startsWith("ALTER TABLE")) return { rows: [] };
      if (sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) { writes.push(params); return { rows: [{ id: "sa-tiktok" }] }; }
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const r = await completeTiktokConnect(event, { brand: "stashbox", user, ...tokens },
    async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(stored[0][1].accessExpiresAt.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(r.body.expiresAt, "2027-10-20T00:00:00.000Z");
  assert.deepEqual(writes.map((p) => [p[1], p[2]]), [["@stashboxmusic", "-000AbCdEf_123456"]]);
});

test("no rows are written when the tokens cannot be stored", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      throw new Error("no SocialAccount query expected");
    },
    async end() {}
  };
  const r = await completeTiktokConnect(event, { brand: "stashbox", user, ...tokens },
    async () => client, json, NOW, async () => { throw new Error("AccessDenied"); });
  assert.equal(r.statusCode, 500);
});
