import test from "node:test";
import assert from "node:assert/strict";
import { PUBLISHING_FORMATS, slideRange, slidesOf, isPlannable } from "../services/dev-api-lambda/publishing-formats.mjs";
import { planWeek, resolvePlannerSettings, carouselMates, slideSetOf } from "../services/dev-api-lambda/planner-v2.mjs";
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
  assert.deepEqual(carousels.map((f) => f.destination).sort(), ["bluesky", "facebook", "instagram", "linkedin", "mastodon", "pinterest", "substack", "threads", "tiktok", "x"]);
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

// Dean 2026-11-07: a Bluesky carousel for the Bauhaus pint glass also showed two tees and another glass.
const slide = (folder, name, extraTags = []) => {
  const a = image(["gear", ...extraTags]);
  return { ...a, filename: name, sourcePath: `/brands/stashbox/merch/video/9x16/${folder}/${name}` };
};

test("a slide-set lead is followed by its own set, in slide order, and nothing else", () => {
  const set = [4, 1, 6, 2, 5, 3].map((i) => slide("150-bauhaus-pint-glass", `every-angle-slide-0${i}-4x5.jpg`, ["product:bauhaus-glass"]));
  const otherProducts = Array.from({ length: 30 }, (_, i) => slide(`tee-${i}`, `hero-poster-${i}-4x5.jpg`, [`product:tee-${i}`]));
  const result = plan([...set, ...otherProducts], { carouselSlides: { "instagram:carousel": { min: 4, max: 8 } } });
  const bauhaus = result.slots.find((s) => s.status === "planned" && set.some((a) => a.id === s.assetId));
  assert.ok(bauhaus, "the set was planned");
  const files = bauhaus.slideIds.map((id) => set.find((a) => a.id === id)?.filename);
  assert.ok(files.every(Boolean), "only slides of the Bauhaus set");
  const rest = files.slice(1).map((f) => slideSetOf({ filename: f }).n);
  assert.deepEqual(rest, [...rest].sort((x, y) => x - y), "the rest follow in slide order");
  assert.equal(bauhaus.slideIds.length, 6, "the whole set, up to the max");
  assert.equal(bauhaus.carouselFill, "set");
});

test("a product lead with too few images of its own hands the slot to a product that has enough; products never mix", () => {
  const lonely = [slide("tee-a", "a-1.jpg", ["product:tee-a"])];
  const full = Array.from({ length: 5 }, (_, i) => slide("glass-b", `b-${i}.jpg`, ["product:glass-b"]));
  const result = plan([...lonely, ...full], { carouselSlides: { "instagram:carousel": { min: 4, max: 8 } } });
  for (const s of result.slots.filter((x) => x.status === "planned")) {
    const keys = new Set(s.slideIds.map((id) => [...lonely, ...full].find((a) => a.id === id).tags.find((t) => t.startsWith("product:"))));
    assert.equal(keys.size, 1, "one product per carousel");
    assert.equal(s.carouselFill, "product");
  }
  assert.ok(result.slots.some((s) => s.status === "planned"), "the glass with 5 images was used");
});

test("a product never borrows generic pillar images, and a generic carousel never takes product images", () => {
  const glass = slide("glass", "glass.jpg", ["product:glass"]);
  const generic = Array.from({ length: 6 }, () => image(["gear"]));
  const tagged = Array.from({ length: 3 }, (_, i) => slide(`p${i}`, `p${i}.jpg`, [`product:p${i}`]));
  const genericLead = carouselMates(generic[0], [glass, ...generic, ...tagged], [glass, ...generic, ...tagged]);
  assert.equal(genericLead.how, "generic");
  assert.ok(genericLead.mates.every((a) => generic.includes(a)));
  const productLead = carouselMates(glass, [glass, ...generic, ...tagged], [glass, ...generic, ...tagged]);
  assert.deepEqual(productLead, { how: "product", mates: [] });
});

test("the one-off refill rebuilds a mixed carousel from its lead's own set and leaves posts that can't be fixed alone", async () => {
  const { refillSlides, runCarouselRefill } = await import("../services/dev-api-lambda/carousel-refill.mjs");
  const set = [1, 2, 3, 4, 5, 6].map((i) => slide("150-bauhaus", `every-angle-slide-0${i}-4x5.jpg`, ["product:bauhaus"]));
  const tee = slide("tee", "tee.jpg", ["product:tee"]);
  const range = { min: 2, max: 4 };
  const mixed = [set[1].id, tee.id, set[3].id];
  const r = refillSlides({ lead: set[1], current: mixed, pool: [...set, tee], range });
  assert.equal(r.how, "set");
  assert.deepEqual(r.ids, [set[1].id, set[0].id, set[2].id, set[3].id], "lead, then its set in order, up to the max");
  assert.equal(refillSlides({ lead: tee, current: [tee.id, set[0].id], pool: [...set, tee], range }).ok, false, "a lone product can't borrow");

  const json = (statusCode, body) => ({ statusCode, body });
  const updates = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", settings: { carouselSlides: { "bluesky:carousel": { min: 2, max: 4 } } } }] };
      if (sql.includes('FROM "Asset"')) return { rows: [...set, tee] };
      if (sql.includes('FROM "ScheduledPost" sp')) return { rows: [
        { id: "p1", assetId: set[1].id, status: "approved", scheduledFor: "2026-11-08T23:49:00Z", slideIds: mixed, destination: "bluesky" },
        { id: "p2", assetId: tee.id, status: "approved", scheduledFor: "2026-11-09T23:49:00Z", slideIds: [tee.id, set[0].id], destination: "bluesky" }] };
      if (sql.startsWith("UPDATE")) { updates.push({ sql, params }); return { rowCount: 1 }; }
      return { rows: [] };
    },
    async end() {}
  };
  const dry = await runCarouselRefill({ brandSlug: "stashbox" }, async () => client, json);
  assert.equal(dry.body.mode, "dry-run");
  assert.deepEqual([dry.body.refilled, dry.body.unfixable], [1, 1]);
  assert.equal(updates.length, 0, "a dry run changes nothing");
  await runCarouselRefill({ brandSlug: "stashbox", mode: "apply" }, async () => client, json);
  assert.equal(updates.length, 1, "only the fixable one is rewritten; the other is left as is without pauseUnfixable");
  assert.equal(JSON.parse(updates[0].params[1]).length, 4);
  updates.length = 0;
  await runCarouselRefill({ brandSlug: "stashbox", mode: "apply", pauseUnfixable: true }, async () => client, json);
  assert.ok(updates.some((u) => u.sql.includes("'paused'") && u.params[0] === "p2"));
  assert.equal((await runCarouselRefill({ brandSlug: "stashbox", rawPath: "/x" }, async () => client, json)).statusCode, 403);
});
