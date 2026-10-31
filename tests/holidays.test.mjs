import test from "node:test";
import assert from "node:assert/strict";
import { handlePlannerReview } from "../services/dev-api-lambda/planner-review.mjs";
import { seedDrafts, holidayDate, holidayTimes, HALLOWEEN_COPY, HOLIDAY_BRAND_SLUGS } from "../services/dev-api-lambda/holidays.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
const event = { headers: { "x-elettro-connect-key": KEY } };
const ASSET = "22222222-2222-4222-8222-222222222222";
const brandRow = (slug = "stashbox") => ({ id: "brand-1", slug, timezone: "America/New_York", settings: {} });

function fakeClient(slug, handlers = []) {
  const seen = [];
  return { seen, async query(sql, params) {
    seen.push({ sql, params });
    if (sql.includes('FROM "Brand" WHERE "slug"')) return { rows: [brandRow(slug)] };
    for (const [match, rows] of handlers) if (sql.includes(match)) return typeof rows === "function" ? rows(params) : rows;
    return { rows: [], rowCount: 0 };
  }, async end() {} };
}
const call = (body, client, deps) => handlePlannerReview(event, body, async () => client, json, deps);

test("every brand has 3 Halloween drafts, no year, German for the two German brands", () => {
  for (const slug of HOLIDAY_BRAND_SLUGS) {
    const d = seedDrafts(slug, "halloween");
    assert.equal(d.length, 3, slug);
    for (const x of d) { assert.ok(!/\b20\d\d\b/.test(x.caption), `${slug} caption has a year`); assert.ok(x.caption.length <= 280); assert.match(x.imageName, new RegExp(`^${slug}_halloween_[123]_4x5\.jpg$`)); }
  }
  assert.match(HALLOWEEN_COPY.solarmeister[0][0], /Frohes Halloween/);
  assert.match(HALLOWEEN_COPY["neckermann-strom"][0][0], /Frohes Halloween/);
});

test("the holiday date is this year's until it passes, then next year's", () => {
  assert.equal(holidayDate("halloween", new Date("2026-10-31T18:00:00Z"), "America/New_York"), "2026-10-31");
  assert.equal(holidayDate("halloween", new Date("2026-11-01T18:00:00Z"), "America/New_York"), "2027-10-31");
});

test("holiday times: after now today, spaced per draft, never on a quarter hour", () => {
  const now = new Date("2026-10-31T18:30:00Z");
  const t = holidayTimes("2026-10-31", "America/New_York", now, 0, ["instagram", "facebook"]);
  assert.ok(t[0].getTime() >= now.getTime() + 25 * 60000);
  assert.ok(t[1] > t[0]);
  for (const d of holidayTimes("2026-10-31", "America/New_York", now, 1, ["bluesky", "mastodon", "threads"])) assert.notEqual(d.getUTCMinutes() % 15, 0);
});

test("holiday-list shows drafts with their picture; an unregistered picture is flagged", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient("stashbox", [
    ['"filename" = ANY', { rows: [{ id: ASSET, filename: "stashbox_halloween_1_4x5.jpg", kind: "image", sourcePath: "/x.jpg" }] }],
    ['"destination" = ANY', { rows: [{ destination: "instagram" }, { destination: "bluesky" }] }]
  ]);
  const r = await call({ action: "holiday-list", brand: "stashbox", key: "halloween" }, client, { now: new Date("2026-10-31T18:00:00Z") });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.date, "2026-10-31");
  assert.equal(r.body.drafts.length, 3);
  assert.equal(r.body.drafts[0].imageReady, true);
  assert.equal(r.body.drafts[1].imageReady, false);
  assert.deepEqual(r.body.destinations.sort(), ["bluesky", "instagram"]);
});

test("holiday-approve makes one approved post per network and blocks drafts without a picture", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const client = fakeClient("stashbox", [
    ['FROM "SocialAccount"', { rows: [{ id: "a1", destination: "bluesky", publishingMode: "auto" }, { id: "a2", destination: "instagram", publishingMode: "auto" }] }],
    ['"filename"=$2', (p) => ({ rows: p[1] === "stashbox_halloween_1_4x5.jpg" ? [{ id: ASSET }] : [] })],
    ['INSERT INTO "ScheduledPost"', { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] }]
  ]);
  const r = await call({ action: "holiday-approve", brand: "stashbox", key: "halloween", draftIds: ["halloween-1", "halloween-2"] }, client, { now: new Date("2026-10-31T18:00:00Z") });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.approved, 1);
  assert.equal(r.body.posts, 2);
  assert.deepEqual(r.body.waitingForImage, ["halloween-2"]);
  const ins = client.seen.filter((q) => q.sql.includes('INSERT INTO "ScheduledPost"'));
  assert.equal(ins.length, 2);
  assert.match(ins[0].sql, /'approved'/);
  assert.equal(JSON.parse(ins[0].params[5]).holiday, "halloween");
});

test("edit validates the caption; a skipped draft cannot be approved", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
  const c1 = fakeClient("stashbox");
  assert.equal((await call({ action: "holiday-edit", brand: "stashbox", key: "halloween", draftId: "halloween-1", caption: "" }, c1)).statusCode, 400);
  const ok = await call({ action: "holiday-edit", brand: "stashbox", key: "halloween", draftId: "halloween-1", caption: "Boo!", hashtags: ["#Halloween"] }, c1);
  assert.equal(ok.statusCode, 200);
  const saved = JSON.parse(c1.seen.find((q) => q.sql.includes('UPDATE "Brand"')).params[2]);
  assert.equal(saved.drafts[0].caption, "Boo!");
  assert.deepEqual(saved.drafts[0].hashtags, ["Halloween"]);
  const none = await call({ action: "holiday-approve", brand: "stashbox", key: "halloween", draftIds: ["nope"] }, fakeClient("stashbox"));
  assert.equal(none.statusCode, 409);
});
