import test from "node:test";
import assert from "node:assert/strict";
import { completeSnapchatConnect } from "../services/dev-api-lambda/snapchat-connect.mjs";
import { DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";
import { DESTINATIONS } from "../services/dev-api-lambda/connection-status.mjs";
import { PUBLISHING_FORMATS, PLANNABLE_DESTINATIONS } from "../services/dev-api-lambda/publishing-formats.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const profile = { id: "d6ed1cac-e0cd-4109-bf04-539cb8591838", displayName: "Stashbox", username: "stashboxmusic" };
const good = { brand: "stashbox", profile, accessToken: "a", refreshToken: "r", expiresIn: 1800 };

// A fake Postgres client that records the queries it gets.
function fakeDatabase({ elsewhere = false, existing = null } = {}) {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1" }] };
      if (sql.includes("ADD COLUMN")) return { rows: [] };
      if (sql.includes('"brandId"<>$2')) return { rows: elsewhere ? [{ "?column?": 1 }] : [] };
      if (sql.includes("SELECT \"id\" FROM \"SocialAccount\"")) return { rows: existing ? [{ id: existing }] : [] };
      if (sql.startsWith("INSERT")) return { rows: [{ id: "new-account" }] };
      return { rows: [], rowCount: 1 };
    },
    async end() {}
  };
  return { connect: async () => client, queries };
}

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  assert.equal((await completeSnapchatConnect({ headers: {} }, good, noDatabase, json)).statusCode, 401);
});

test("completion rejects bad input before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const bad = [
    { ...good, accessToken: "" },
    { ...good, refreshToken: "" },
    { ...good, brand: "Stash Box" },
    { ...good, profile: { ...profile, id: "12345" } },
    { brand: "stashbox", accessToken: "a", refreshToken: "r" }
  ];
  for (const body of bad) assert.equal((await completeSnapchatConnect(event, body, noDatabase, json)).statusCode, 400);
});

test("a database failure comes back as an error, not a crash", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeSnapchatConnect(event, good, noDatabase, json, new Date(), async () => {});
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.ok, false);
});

test("a connect stores the tokens first, then inserts the snapchat account with the profile id and no reconnect date", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const db = fakeDatabase();
  const stored = [];
  const now = new Date("2026-11-05T12:00:00Z");
  const r = await completeSnapchatConnect(event, good, db.connect, json, now, async (record) => { stored.push(record); });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.profile.handle, "@stashboxmusic");
  assert.equal(stored[0].profileId, profile.id);
  assert.equal(stored[0].accessExpiresAt, "2026-11-05T12:30:00.000Z");
  assert.equal(stored[0].refreshToken, "r");
  const insert = db.queries.find((q) => q.sql.startsWith("INSERT"));
  assert.ok(insert.sql.includes("'snapchat'"));
  assert.deepEqual(insert.params, ["b1", "@stashboxmusic", profile.id]);
});

test("an existing unlinked row is reused instead of inserting a second one", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const db = fakeDatabase({ existing: "seed-row" });
  const r = await completeSnapchatConnect(event, good, db.connect, json, new Date(), async () => {});
  assert.equal(r.body.socialAccountId, "seed-row");
  assert.ok(!db.queries.some((q) => q.sql.startsWith("INSERT")));
});

test("a profile already linked to another brand is refused", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeSnapchatConnect(event, good, fakeDatabase({ elsewhere: true }).connect, json, new Date(), async () => {});
  assert.equal(r.statusCode, 409);
});

test("Snapchat is wired into disconnect, the status feed and the publishing formats", () => {
  assert.deepEqual(DISCONNECT_NETWORKS.snapchat, ["snapchat"]);
  assert.ok(DESTINATIONS.includes("snapchat"));
  assert.ok(PLANNABLE_DESTINATIONS.includes("snapchat"));
  const formats = PUBLISHING_FORMATS.filter((f) => f.destination === "snapchat");
  assert.deepEqual(formats.map((f) => f.placement).sort(), ["spotlight", "story"]);
  for (const f of formats) assert.equal(f.status, "planning");
});
