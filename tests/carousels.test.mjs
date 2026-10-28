import test from "node:test";
import assert from "node:assert/strict";
import { PUBLISHING_FORMATS, slideRange, slidesOf, isPlannable } from "../services/dev-api-lambda/publishing-formats.mjs";
import { planWeek, resolvePlannerSettings } from "../services/dev-api-lambda/planner-v2.mjs";
import { handlePlannerReview } from "../services/dev-api-lambda/planner-review.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const event = { headers: { "x-elettro-connect-key": KEY } };

function fakeClient(brandSettings = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "brand-1", slug: "stashbox", timezone: "America/New_York", settings: brandSettings }] };
      return { rows: [], rowCount: 1 };
    },
    async end() {}
  };
}

test("every carousel network has hard limits and a recommended range inside them", () => {
  const carousels = PUBLISHING_FORMATS.filter((f) => f.placement === "carousel");
  assert.deepEqual(carousels.map((f) => f.destination).sort(), ["facebook", "instagram", "linkedin", "pinterest", "threads", "tiktok"]);
  for (const f of carousels) {
    const [lo, hi] = f.slides.recommended;
    assert.ok(f.slides.min >= 2 && f.slides.min <= lo && lo <= hi && hi <= f.slides.max, `${f.destination} recommended range`);
    assert.equal(isPlannable(f), true);
    assert.equal(f.status, f.destination === "tiktok" ? "review" : "planning", "a carousel goes live only after it publishes once on schedule");
    assert.deepEqual(f.rule.kinds, ["image"]);
  }
  assert.equal(slidesOf("pinterest", "carousel").max, 5);
  assert.equal(slidesOf("instagram", "post"), null);
});

test("slide range defaults to the recommended range and a brand's own range is clamped to the network", () => {
  assert.deepEqual(slideRange({}, "instagram", "carousel"), { min: 5, max: 8 });
  assert.deepEqual(slideRange({ carouselSlides: { "instagram:carousel": { min: 3, max: 9 } } }, "instagram", "carousel"), { min: 3, max: 9 });
  assert.deepEqual(slideRange({ carouselSlides: { "pinterest:carousel": { min: 1, max: 40 } } }, "pinterest", "carousel"), { min: 2, max: 5 });
  assert.equal(slideRange({}, "instagram", "post"), null);
});

const TZ = "America/New_York";
let n = 0;
const image = (tags) => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, filename: `p${n}.jpg`, kind: "image", aspectRatioLabel: "4x5", tags,
  priority: "normal", eligibilityType: "evergreen", allowedDestinations: [], excludedDestinations: [], createdAt: "2026-10-01T00:00:00Z"
});
const account = { socialAccountId: "ig", destination: "instagram", placement: "carousel", accountName: "ig", postsPerWeek: 7,
  preferredStartTime: "12:00", preferredEndTime: "18:00", publishingMode: "approval", timezone: TZ };
const plan = (assets, brandSettings = {}) => planWeek({
  assets, accounts: [account], weekStart: "2026-10-19", timeZone: TZ, now: new Date("2026-10-17T12:00:00Z"),
  settings: resolvePlannerSettings({ ...brandSettings, planner: { sectors: [{ slug: "gear", priority: 1, share: 1, match: { tagsAny: ["gear"] } }, { slug: "live", priority: 2, share: 1, match: { tagsAny: ["live"] } }], cooldowns: { assetDays: 30, songDays: 0, productDays: 0 } } })
});

test("a planned carousel holds min..max images of one sector and never reuses an image across the week", () => {
  const assets = [...Array.from({ length: 80 }, () => image(["gear"])), ...Array.from({ length: 80 }, () => image(["live"]))];
  const result = plan(assets, { carouselSlides: { "instagram:carousel": { min: 4, max: 6 } } });
  const planned = result.slots.filter((s) => s.status === "planned");
  assert.ok(planned.length > 0);
  const seen = new Set();
  for (const s of planned) {
    assert.ok(s.slideIds.length >= 4 && s.slideIds.length <= 6, `slides ${s.slideIds.length}`);
    assert.equal(s.slideIds[0], s.assetId, "the lead image is the first slide");
    const sectors = new Set(s.slideIds.map((id) => assets.find((a) => a.id === id).tags[0]));
    assert.equal(sectors.size, 1, "one pillar per carousel");
    for (const id of s.slideIds) { assert.ok(!seen.has(id), "image reused"); seen.add(id); }
  }
});

test("a sector without enough images for the minimum leaves a gap instead of a thin carousel", () => {
  const assets = [image(["gear"]), image(["gear"]), image(["gear"])];
  const result = plan(assets, { carouselSlides: { "instagram:carousel": { min: 5, max: 8 } } });
  assert.equal(result.slots.filter((s) => s.status === "planned").length, 0);
  assert.match(result.gaps[0].reason, /needs at least 5/);
});

test("single-image formats plan without slides", () => {
  const assets = Array.from({ length: 20 }, () => image(["gear"]));
  const result = planWeek({ assets, accounts: [{ ...account, placement: "post" }], weekStart: "2026-10-19", timeZone: TZ, now: new Date("2026-10-17T12:00:00Z"),
    settings: resolvePlannerSettings({ planner: { sectors: [{ slug: "gear", priority: 1, share: 1, match: { tagsAny: ["gear"] } }] } }) });
  assert.ok(result.slots.every((s) => s.slideIds === null));
});

test("the slides action saves a range inside the network's limits and refuses the rest", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient();
  const ok = await handlePlannerReview(event, { brand: "stashbox", action: "slides", destination: "pinterest", placement: "carousel", min: 3, max: 5 }, async () => client, json);
  assert.equal(ok.statusCode, 200);
  const update = client.seen.find((q) => q.sql.includes("carouselSlides"));
  assert.deepEqual(update.params.slice(1), ["pinterest:carousel", JSON.stringify({ min: 3, max: 5 })]);
  for (const bad of [{ min: 3, max: 6 }, { min: 1, max: 4 }, { min: 5, max: 3 }]) {
    const r = await handlePlannerReview(event, { brand: "stashbox", action: "slides", destination: "pinterest", placement: "carousel", ...bad }, async () => fakeClient(), json);
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  const notCarousel = await handlePlannerReview(event, { brand: "stashbox", action: "slides", destination: "instagram", placement: "post", min: 2, max: 3 }, async () => fakeClient(), json);
  assert.equal(notCarousel.statusCode, 400);
});

test("the review list reports each carousel format's current range", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const r = await handlePlannerReview(event, { brand: "stashbox", action: "list" }, async () => fakeClient({ carouselSlides: { "threads:carousel": { min: 4, max: 4 } } }), json);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.slideRanges["threads:carousel"], { min: 4, max: 4 });
  assert.deepEqual(r.body.slideRanges["instagram:carousel"], { min: 5, max: 8 });
  assert.ok(r.body.formats.find((f) => f.destination === "tiktok" && f.placement === "carousel").slides.max === 35);
});
