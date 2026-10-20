import test from "node:test";
import assert from "node:assert/strict";
import { completeThreadsConnect } from "../services/dev-api-lambda/threads-connect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const user = { id: "25000000000000001", username: "stashboxmusic" };
const NOW = new Date("2026-10-20T00:00:00Z");

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeThreadsConnect({ headers: {} }, { brand: "stashbox", user, accessToken: "t" }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, user or token before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeThreadsConnect(event, { brand: "stashbox", user }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeThreadsConnect(event, { brand: "stashbox", user: { id: "@stashboxmusic" }, accessToken: "t" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeThreadsConnect(event, { brand: "Stash Box", user, accessToken: "t" }, noDatabase, json)).statusCode, 400);
});

test("a Threads profile links to the brand's threads row with a 60-day expiry", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const writes = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [] };
      if (sql.startsWith("ALTER TABLE")) return { rows: [] };
      if (sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) { writes.push(params); return { rows: [{ id: "sa-threads" }] }; }
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const r = await completeThreadsConnect(event, { brand: "stashbox", user, accessToken: "t", expiresIn: 5184000 },
    async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(r.body.expiresAt, "2026-12-19T00:00:00.000Z");
  assert.deepEqual(writes.map((p) => [p[1], p[2]]), [["@stashboxmusic", "25000000000000001"]]);
});

test("no rows are written when the token cannot be stored", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      throw new Error("no SocialAccount query expected");
    },
    async end() {}
  };
  const r = await completeThreadsConnect(event, { brand: "stashbox", user, accessToken: "t" },
    async () => client, json, NOW, async () => { throw new Error("AccessDenied"); });
  assert.equal(r.statusCode, 500);
});
