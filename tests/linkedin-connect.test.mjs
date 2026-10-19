import test from "node:test";
import assert from "node:assert/strict";
import { completeLinkedinConnect, expiresAtFrom } from "../services/dev-api-lambda/linkedin-connect.mjs";

const NOW = new Date("2026-10-19T12:00:00Z");
const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };

test("expiry follows LinkedIn's expires_in, falling back to 60 days", () => {
  assert.equal(expiresAtFrom(5184000, NOW).toISOString(), "2026-12-18T12:00:00.000Z");
  assert.equal(expiresAtFrom(undefined, NOW).toISOString(), "2026-12-18T12:00:00.000Z");
  assert.equal(expiresAtFrom(-5, NOW).toISOString(), "2026-12-18T12:00:00.000Z");
  assert.equal(expiresAtFrom(3600, NOW).toISOString(), "2026-10-19T13:00:00.000Z");
});

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeLinkedinConnect({ headers: {} }, { brand: "elettro" }, noDatabase, json, NOW);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a missing member or token before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const event = { headers: { "x-elettro-connect-key": KEY } };
  assert.equal((await completeLinkedinConnect(event, { brand: "elettro", member: { id: "abc123" } }, noDatabase, json, NOW)).statusCode, 400);
  assert.equal((await completeLinkedinConnect(event, { brand: "elettro", member: { id: "bad id!" }, accessToken: "t" }, noDatabase, json, NOW)).statusCode, 400);
  assert.equal((await completeLinkedinConnect(event, { brand: "Elettro OS", member: { id: "abc123" }, accessToken: "t" }, noDatabase, json, NOW)).statusCode, 400);
});
