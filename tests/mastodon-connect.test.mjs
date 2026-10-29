import test from "node:test";
import assert from "node:assert/strict";
import { completeMastodonConnect, accountKey } from "../services/dev-api-lambda/mastodon-connect.mjs";
import { DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";
import { DESTINATIONS } from "../services/dev-api-lambda/connection-status.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const account = { id: "109876543210", acct: "solarmeister", instance: "mastodon.social" };

test("account key is the account id plus its instance", () => {
  assert.equal(accountKey("mastodon.social", "109876543210"), "109876543210@mastodon.social");
});

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeMastodonConnect({ headers: {} }, { brand: "solarmeister" }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects bad input before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const bad = [
    { brand: "solarmeister", account, accessToken: "" },
    { brand: "Solar Meister", account, accessToken: "t" },
    { brand: "solarmeister", account: { ...account, id: "abc" }, accessToken: "t" },
    { brand: "solarmeister", account: { ...account, instance: "bad host/evil" }, accessToken: "t" },
    { brand: "solarmeister", accessToken: "t" }
  ];
  for (const body of bad) assert.equal((await completeMastodonConnect(event, body, noDatabase, json)).statusCode, 400);
});

test("a database failure comes back as an error, not a crash", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeMastodonConnect(event, { brand: "solarmeister", account, accessToken: "t" }, noDatabase, json);
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
});

test("mastodon can be disconnected and appears in the status destinations", () => {
  assert.deepEqual(DISCONNECT_NETWORKS.mastodon, ["mastodon"]);
  assert.ok(DESTINATIONS.includes("mastodon"));
});
