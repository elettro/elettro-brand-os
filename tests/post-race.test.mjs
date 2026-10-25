import test from "node:test";
import assert from "node:assert/strict";
import { buildRace, postRaceFeed, GOAL } from "../services/dev-api-lambda/post-race.mjs";

const brands = [{ id: "b1", slug: "stashbox", name: "Stashbox" }, { id: "b2", slug: "elettro", name: "Elettro" }, { id: "lib", slug: "creative-assets", name: "Library" }];
const at = (s) => new Date(s);

test("counts roll up per brand, per network and overall; library brand is ignored", () => {
  const race = buildRace({
    brands, finishes: {},
    published: [
      { brandId: "b1", destination: "youtube", n: 3, firstAt: at("2026-10-20T10:00:00Z"), lastAt: at("2026-10-24T10:00:00Z") },
      { brandId: "b1", destination: "tiktok", n: 2, firstAt: at("2026-10-21T10:00:00Z"), lastAt: at("2026-10-22T10:00:00Z") },
      { brandId: "b2", destination: "youtube", n: 4, firstAt: at("2026-10-19T10:00:00Z"), lastAt: at("2026-10-23T10:00:00Z") },
      { brandId: "lib", destination: "youtube", n: 99, firstAt: at("2026-10-01T10:00:00Z"), lastAt: at("2026-10-02T10:00:00Z") }
    ],
    scheduled: [{ brandId: "b1", destination: "youtube", n: 10 }]
  });
  assert.equal(race.goal, GOAL);
  assert.equal(race.total.published, 9);
  assert.equal(race.total.scheduled, 10);
  assert.equal(race.total.firstAt, "2026-10-19T10:00:00.000Z");
  assert.equal(race.destinations.find((d) => d.destination === "youtube").published, 7);
  assert.equal(race.destinations.find((d) => d.destination === "tiktok").published, 2);
  const sb = race.brands.find((b) => b.slug === "stashbox");
  assert.deepEqual([sb.published, sb.scheduled, sb.byDestination.tiktok], [5, 10, 2]);
  assert.equal(race.brands.length, 2);
});

test("finishedAt is passed through only for scopes that crossed the line", () => {
  const race = buildRace({
    brands, scheduled: [], published: [{ brandId: "b1", destination: "youtube", n: 1000, firstAt: at("2026-10-26T00:00:00Z"), lastAt: at("2026-11-20T00:00:00Z") }],
    finishes: { all: at("2026-11-19T00:00:00Z"), "d:youtube": at("2026-11-19T00:00:00Z"), "b:b1": at("2026-11-19T00:00:00Z") }
  });
  assert.equal(race.total.finishedAt, "2026-11-19T00:00:00.000Z");
  assert.equal(race.brands.find((b) => b.slug === "stashbox").finishedAt, "2026-11-19T00:00:00.000Z");
  assert.equal(race.brands.find((b) => b.slug === "elettro").finishedAt, null);
});

test("feed queries the ledger and looks up the 1000th post only for scopes at the goal", async () => {
  const seen = [];
  const client = {
    async query(sql, params) {
      seen.push(sql);
      if (sql.includes('FROM "Brand"')) return { rows: brands };
      if (sql.includes('GROUP BY "brandId", "destination"')) return { rows: [{ brandId: "b1", destination: "youtube", n: 1000, firstAt: at("2026-10-26T00:00:00Z"), lastAt: at("2026-11-20T00:00:00Z") }] };
      if (sql.includes('"ScheduledPost"')) return { rows: [] };
      return { rows: [{ publishedAt: at("2026-11-19T00:00:00Z") }] };
    },
    async end() {}
  };
  const race = await postRaceFeed(async () => client, { now: Date.now() + 10 * 60_000 });
  assert.equal(race.total.finishedAt, "2026-11-19T00:00:00.000Z");
  assert.equal(seen.filter((s) => s.includes("OFFSET 999")).length, 3);
});
