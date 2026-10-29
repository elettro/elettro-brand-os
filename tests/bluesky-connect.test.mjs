import test from "node:test";
import assert from "node:assert/strict";
import { completeBlueskyConnect, secretNameFor } from "../services/dev-api-lambda/bluesky-connect.mjs";
import { PUBLISHING_FORMATS, formatOf, slideRange } from "../services/dev-api-lambda/publishing-formats.mjs";
import { DISCONNECT_NETWORKS } from "../services/dev-api-lambda/connection-disconnect.mjs";
import { DESTINATIONS } from "../services/dev-api-lambda/connection-status.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const noDatabase = async () => { throw new Error("database should not be reached"); };
const event = { headers: { "x-elettro-connect-key": KEY } };
const account = { did: "did:plc:abcdefghijklmnopqrstuvwx", handle: "stashboxmusic.bsky.social", pds: "https://morel.us-east.host.bsky.network" };
const session = { dpopJwk: { kty: "EC" }, authMethod: "private_key_jwt", tokenSet: { refresh_token: "r", access_token: "a", aud: account.pds } };
const NOW = new Date("2026-10-30T00:00:00Z");

test("completion needs the shared connect key", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await completeBlueskyConnect({ headers: {} }, { brand: "stashbox", account, session }, noDatabase, json);
  assert.equal(r.statusCode, 401);
});

test("completion rejects a bad brand, DID, PDS or session before touching the database", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const bad = [
    { brand: "Stash Box", account, session },
    { brand: "stashbox", account: { ...account, did: "stashboxmusic" }, session },
    { brand: "stashbox", account: { ...account, pds: "http://insecure.example" }, session },
    { brand: "stashbox", account, session: { dpopJwk: {}, tokenSet: {} } },
    { brand: "stashbox", account }
  ];
  for (const body of bad) assert.equal((await completeBlueskyConnect(event, body, noDatabase, json)).statusCode, 400);
});

test("a Bluesky account links to the brand's bluesky row with a 180-day reconnect date", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const writes = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [] };
      if (sql.startsWith("ALTER TABLE")) return { rows: [] };
      if (sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) { writes.push(params); return { rows: [{ id: "sa-bluesky" }] }; }
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const r = await completeBlueskyConnect(event, { brand: "stashbox", account, session }, async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(r.body.expiresAt, "2027-04-28T00:00:00.000Z");
  assert.deepEqual(writes.map((p) => [p[1], p[2]]), [["@stashboxmusic.bsky.social", account.did]]);
});

test("a server address with a trailing slash (what the OAuth library returns) is accepted and stored bare", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [] };
      if (sql.startsWith("ALTER TABLE") || sql.startsWith("\n    SELECT")) return { rows: [] };
      if (sql.includes("INSERT INTO")) return { rows: [{ id: "sa-bluesky" }] };
      throw new Error("unexpected query " + sql);
    },
    async end() {}
  };
  const stored = [];
  const body = { brand: "stashbox", account: { ...account, pds: account.pds + "/" }, session };
  const r = await completeBlueskyConnect(event, body, async () => client, json, NOW, async (...args) => { stored.push(args); });
  assert.equal(r.statusCode, 200);
  assert.equal(stored.length, 1);
});

test("an account already linked to another brand is refused, and nothing is written", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      if (sql.includes('"brandId"<>')) return { rows: [{}] };
      throw new Error("no further query expected");
    },
    async end() {}
  };
  const r = await completeBlueskyConnect(event, { brand: "stashbox", account, session }, async () => client, json, NOW, async () => {});
  assert.equal(r.statusCode, 409);
});

test("no rows are written when the session cannot be stored", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = {
    async query(sql) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1" }] };
      throw new Error("no SocialAccount query expected");
    },
    async end() {}
  };
  const r = await completeBlueskyConnect(event, { brand: "stashbox", account, session }, async () => client, json, NOW, async () => { throw new Error("AccessDenied"); });
  assert.equal(r.statusCode, 500);
});

test("the secret name is legal for Secrets Manager (no colons)", () => {
  assert.equal(secretNameFor("did:plc:abc"), "elettro-brand-os-dev/bluesky/did_plc_abc");
  assert.match(secretNameFor("did:web:example.com"), /^[A-Za-z0-9/_+=.@-]+$/);
});

test("Bluesky shows up in connections, disconnect and the Review formats", () => {
  assert.ok(DESTINATIONS.includes("bluesky"));
  assert.deepEqual(DISCONNECT_NETWORKS.bluesky, ["bluesky"]);
  const formats = PUBLISHING_FORMATS.filter((f) => f.destination === "bluesky").map((f) => f.placement);
  assert.deepEqual(formats, ["post", "carousel", "video"]);
  assert.ok(formats.every((p) => formatOf("bluesky", p).status === "planning"));
  // A Bluesky post holds at most 4 photos.
  const range = slideRange({}, "bluesky", "carousel");
  assert.ok(range.min >= 2 && range.max <= 4);
});
