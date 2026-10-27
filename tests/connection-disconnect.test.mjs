import test from "node:test";
import assert from "node:assert/strict";
import { disconnectNetwork, DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };

test("disconnect needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await disconnectNetwork({ headers: {} }, { brand: "stashbox", network: "youtube" }, noDatabase, json)).statusCode, 401);
});

test("a bad brand or unknown network is rejected before the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await disconnectNetwork(event, { brand: "Stash Box", network: "youtube" }, noDatabase, json)).statusCode, 400);
  assert.equal((await disconnectNetwork(event, { brand: "stashbox", network: "myspace" }, noDatabase, json)).statusCode, 400);
  assert.equal((await disconnectNetwork(event, { brand: "stashbox" }, noDatabase, json)).statusCode, 400);
});

test("YouTube disconnect unlinks the brand's row and holds its approved posts", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const seen = [];
  const client = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes('UPDATE "SocialAccount"')) return { rows: [{ id: "sa" }], rowCount: 1 };
      if (sql.includes('UPDATE "ScheduledPost"')) return { rows: [{ id: "p1" }, { id: "p2" }], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  };
  const r = await disconnectNetwork(event, { brand: "google-review", network: "youtube" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.disconnected, 1);
  assert.equal(r.body.postsHeld, 2);
  const unlink = seen.find((q) => q.sql.includes('UPDATE "SocialAccount"'));
  assert.match(unlink.sql, /"externalAccountId"=NULL/);
  assert.deepEqual(unlink.params, ["google-review", ["youtube"]]);
  const hold = seen.find((q) => q.sql.includes('UPDATE "ScheduledPost"'));
  assert.match(hold.sql, /"status"='planned'/);
  assert.match(hold.sql, /sp\."status"='approved'/);
  assert.deepEqual(hold.params, ["google-review", ["youtube"]]);
});

test("Meta covers both Facebook and Instagram", () => {
  assert.deepEqual(DISCONNECT_NETWORKS.meta, ["facebook", "instagram"]);
});

test("a database failure reports an error and closes the connection", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  let closed = false;
  const client = { async query() { throw new Error("boom"); }, async end() { closed = true; } };
  const r = await disconnectNetwork(event, { brand: "stashbox", network: "tiktok" }, async () => client, json);
  assert.equal(r.statusCode, 500);
  assert.ok(closed);
});
