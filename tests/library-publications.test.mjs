import test from "node:test";
import assert from "node:assert/strict";
import { searchLibrary, recordPublication, libraryAsset } from "../services/dev-api-lambda/library-publications.mjs";

const brand = { id: "brand-1", slug: "stashbox" };
const ASSET = "0f8c2c62-6c5e-4a8e-9a0f-0b7f5a1d2e3f";

function client(handlers) {
  const seen = [];
  return { seen, async query(sql, params) {
    seen.push({ sql, params });
    for (const [match, rows] of handlers) if (sql.includes(match)) return { rows };
    return { rows: [] };
  } };
}

test("the picker only searches approved, ready photos and videos of the brand", async () => {
  const c = client([['FROM "Asset"', [{ id: "a" }, { id: "b" }, { id: "c" }]]]);
  const r = await searchLibrary(c, brand, { kind: "video", q: "dylan", limit: 2 });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.assets.map((a) => a.id), ["a", "b"]);
  assert.equal(r.body.more, true);
  const { sql, params } = c.seen[0];
  assert.match(sql, /"approvalStatus"='approved' AND "ingestStatus"='ready'/);
  assert.deepEqual(params.slice(0, 4), ["brand-1", "video", "dylan", 3]);
});

test("an asset id must be a uuid", async () => {
  assert.equal((await libraryAsset(client([]), brand, { id: "../etc" })).code, 400);
});

test("a publication is logged as an api post on the connected account", async () => {
  const c = client([['FROM "SocialAccount"', [{ id: "sa-ig" }]], ['INSERT INTO "PublicationLedger"', [{ id: "pl-1" }]]]);
  const r = await recordPublication(c, brand, { destination: "instagram", placement: "reel", assetId: ASSET, externalPostId: "17891555235458513", externalUrl: "https://www.instagram.com/p/x/" });
  assert.equal(r.code, 200);
  const insert = c.seen.find((q) => q.sql.includes("INSERT"));
  assert.match(insert.sql, /'api'/);
  assert.deepEqual(insert.params.slice(0, 5), ["brand-1", "sa-ig", "instagram", "reel", "17891555235458513"]);
});

test("logging needs a connected account and a known network", async () => {
  assert.equal((await recordPublication(client([]), brand, { destination: "instagram", placement: "reel", assetId: ASSET, externalPostId: "1" })).code, 409);
  assert.equal((await recordPublication(client([]), brand, { destination: "myspace", placement: "post", assetId: ASSET, externalPostId: "1" })).code, 400);
});
