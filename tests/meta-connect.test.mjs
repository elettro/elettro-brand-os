import test from "node:test";
import assert from "node:assert/strict";
import { completeMetaConnect } from "../services/dev-api-lambda/meta-connect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const page = { id: "380791482028270", name: "Stashbox" };

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeMetaConnect({ headers: {} }, { brand: "stashbox", page, pageToken: "t" }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, Page, token or Instagram id before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeMetaConnect(event, { brand: "stashbox", page }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeMetaConnect(event, { brand: "stashbox", page: { id: "not-a-page" }, pageToken: "t" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeMetaConnect(event, { brand: "Stash Box", page, pageToken: "t" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeMetaConnect(event, { brand: "stashbox", page, pageToken: "t", instagram: { id: "@stashboxmusic" } }, noDatabase, json)).statusCode, 400);
});

test("a Page and its Instagram account link to the brand's facebook and instagram rows", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const writes = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [] };
      if (sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) { writes.push(params); return { rows: [{ id: `sa-${params[1]}` }] }; }
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const r = await completeMetaConnect(event,
    { brand: "stashbox", page, pageToken: "t", instagram: { id: "17841450377375277", username: "stashboxmusic" } },
    async () => client, json, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.deepEqual(writes.map((p) => [p[1], p[2], p[3]]), [
    ["facebook", "Stashbox", "380791482028270"],
    ["instagram", "@stashboxmusic", "17841450377375277"]
  ]);
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
  const r = await completeMetaConnect(event, { brand: "stashbox", page, pageToken: "t" },
    async () => client, json, async () => { throw new Error("AccessDenied"); });
  assert.equal(r.statusCode, 500);
});
