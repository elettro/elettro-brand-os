import test from "node:test";
import assert from "node:assert/strict";
import { completeXConnect } from "../services/dev-api-lambda/x-connect.mjs";
import { DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";
import { DESTINATIONS } from "../services/dev-api-lambda/connection-status.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const account = { id: "1234567890123456789", username: "stashboxmusic" };

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeXConnect({ headers: {} }, { brand: "stashbox" }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects bad input before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const bad = [
    { brand: "stashbox", account, accessToken: "" },
    { brand: "Stash Box", account, accessToken: "t" },
    { brand: "stashbox", account: { ...account, id: "abc" }, accessToken: "t" },
    { brand: "stashbox", account: { ...account, username: "bad name!" }, accessToken: "t" },
    { brand: "stashbox", account: { ...account, username: "waytoolongusername1" }, accessToken: "t" },
    { brand: "stashbox", accessToken: "t" }
  ];
  for (const body of bad) assert.equal((await completeXConnect(event, body, noDatabase, json)).statusCode, 400);
});

test("a database failure comes back as an error, not a crash", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeXConnect(event, { brand: "stashbox", account, accessToken: "t", refreshToken: "r" }, noDatabase, json);
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
});

test("an account already linked to another brand is refused with 409", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const connectDatabase = async () => ({
    query: async (sql) => {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1" }] };
      if (sql.includes('"brandId"<>$2')) return { rows: [{ "?column?": 1 }] };
      throw new Error("should have stopped at the conflict: " + sql.slice(0, 40));
    },
    end: async () => {}
  });
  const r = await completeXConnect(event, { brand: "stashbox", account, accessToken: "t" }, connectDatabase, json);
  assert.equal(r.statusCode, 409);
});

test("x can be disconnected and is a status destination", () => {
  assert.deepEqual(DISCONNECT_NETWORKS.x, ["x"]);
  assert.ok(DESTINATIONS.includes("x"));
});
