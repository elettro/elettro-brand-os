import test from "node:test";
import assert from "node:assert/strict";
import { completeGmbConnect, LOCATION_ID } from "../services/dev-api-lambda/gmb-connect.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const location = { id: "accounts/1234567890/locations/9876543210", title: "Stashbox" };

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeGmbConnect({ headers: {} }, { brand: "stashbox", location, refreshToken: "r" }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, location or token before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeGmbConnect(event, { brand: "stashbox", location }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeGmbConnect(event, { brand: "stashbox", location: { id: "locations/9876543210" }, refreshToken: "r" }, noDatabase, json)).statusCode, 400);
  assert.equal((await completeGmbConnect(event, { brand: "Stash Box", location, refreshToken: "r" }, noDatabase, json)).statusCode, 400);
});

test("location ids must be accounts/<n>/locations/<n>", () => {
  assert.ok(LOCATION_ID.test(location.id));
  assert.ok(!LOCATION_ID.test("accounts/abc/locations/123"));
  assert.ok(!LOCATION_ID.test("accounts/1234567890/locations/9876543210/extra"));
});

test("a profile already linked to another brand is refused", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [{ "?column?": 1 }] };
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const r = await completeGmbConnect(event, { brand: "stashbox", location, refreshToken: "r" }, async () => client, json);
  assert.equal(r.statusCode, 409);
});
