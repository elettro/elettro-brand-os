import test from "node:test";
import assert from "node:assert/strict";
import { completePinterestConnect } from "../services/dev-api-lambda/pinterest-connect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const user = { id: "549755885175", username: "elettro", name: "Elettro" };
const tokens = { accessToken: "a", refreshToken: "r", expiresIn: 2592000, refreshExpiresIn: 5184000, scope: "boards:read,pins:write" };
const NOW = new Date("2026-10-20T00:00:00Z");

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completePinterestConnect({ headers: {} }, { brand: "elettro", user, ...tokens }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, user or missing tokens before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completePinterestConnect(event, { brand: "elettro", user, accessToken: "a" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completePinterestConnect(event, { brand: "elettro", user: { id: "bad id!" }, ...tokens }, noDatabase, json)).statusCode, 400);
  assert.equal((await completePinterestConnect(event, { brand: "Elettro Inc", user, ...tokens }, noDatabase, json)).statusCode, 400);
});

test("a Pinterest account links to the brand's pinterest row; reconnect date = refresh token expiry", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const writes = [], updates = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"id"<>')) { updates.push(params); return { rows: [] }; }
      if (sql.startsWith("ALTER TABLE")) return { rows: [] };
      if (sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) { writes.push(params); return { rows: [{ id: "sa-pinterest" }] }; }
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const r = await completePinterestConnect(event, { brand: "elettro", user, ...tokens },
    async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(stored[0][1].accessExpiresAt.toISOString(), "2026-11-19T00:00:00.000Z");
  assert.equal(r.body.expiresAt, "2026-12-19T00:00:00.000Z");
  assert.deepEqual(writes.map((p) => [p[1], p[2]]), [["@elettro", "549755885175"]]);
  // Other brands on the same account get the new reconnect date.
  assert.deepEqual(updates.map((p) => [p[0], p[2]]), [["549755885175", "sa-pinterest"]]);
});

test("a second brand on the same Pinterest account keeps the first one in the token's brand list", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-2" }] };
      if (sql.includes("INSERT INTO")) return { rows: [{ id: "sa-stashbox" }] };
      return { rows: [] };
    },
    async end() {}
  };
  const stored = [];
  const r = await completePinterestConnect(event, { brand: "stashbox", brands: ["elettro", "Bad Slug"], user, ...tokens },
    async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(stored[0][3], ["elettro", "stashbox"]);
});

test("a username stands in for the account id when Pinterest returns none", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes("INSERT INTO")) return { rows: [{ id: "sa-pinterest" }] };
      return { rows: [] };
    },
    async end() {}
  };
  const r = await completePinterestConnect(event, { brand: "elettro", user: { id: "elettro", username: "elettro" }, ...tokens },
    async () => client, json, NOW, async () => {});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.user.id, "elettro");
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
  const r = await completePinterestConnect(event, { brand: "elettro", user, ...tokens },
    async () => client, json, NOW, async () => { throw new Error("AccessDenied"); });
  assert.equal(r.statusCode, 500);
});
