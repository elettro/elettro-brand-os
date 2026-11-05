import test from "node:test";
import assert from "node:assert/strict";
import { completeSubstackConnect } from "../services/dev-api-lambda/substack-connect.mjs";
import { DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";
import { DESTINATIONS } from "../services/dev-api-lambda/connection-status.mjs";
import { PUBLISHING_FORMATS, isPlannable } from "../services/dev-api-lambda/publishing-formats.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const good = { brand: "elettro", subdomain: "elettro", userId: "123456", handle: "elettro", cookie: "substack.sid=s%3Aabcdefghijklmnopqrstuvwxyz" };

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeSubstackConnect({ headers: {} }, good, noDatabase, json)).statusCode, 401);
});

test("completion rejects bad input before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const bad = [
    { ...good, cookie: "" }, { ...good, cookie: "short" }, { ...good, cookie: good.cookie + "\nx: y" },
    { ...good, brand: "Elettro Brand" }, { ...good, subdomain: "bad host/evil" }, { ...good, subdomain: "" },
    { ...good, userId: "abc" }, { ...good, userId: "" }
  ];
  for (const body of bad) assert.equal((await completeSubstackConnect(event, body, noDatabase, json)).statusCode, 400);
});

test("a database failure comes back as an error, never echoing the cookie", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeSubstackConnect(event, good, noDatabase, json);
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
  assert.ok(!JSON.stringify(r).includes("abcdefghijklmnop"));
});

test("substack can be disconnected, appears in status destinations, and has one planned photo format", () => {
  assert.deepEqual(DISCONNECT_NETWORKS.substack, ["substack"]);
  assert.ok(DESTINATIONS.includes("substack"));
  const formats = PUBLISHING_FORMATS.filter((f) => f.destination === "substack");
  assert.deepEqual(formats.map((f) => f.placement), ["post"]);
  assert.equal(formats[0].status, "planning");
  assert.ok(isPlannable(formats[0]));
});
