import test from "node:test";
import assert from "node:assert/strict";
import {
  GMB_DEFAULTS, gmbConfigFor, captionProblem, captionHasUrl, spreadDays, slotMinute, nextPillar, photoProblem, pillarOfFilename,
  pickPhoto, pickCaption, planGmbWeek, localMinutesOf
} from "../services/dev-api-lambda/gmb-planner.mjs";
import { postRequest, findUrl } from "../services/gmb-lambda/index.mjs";
import { handlePlannerReview } from "../services/dev-api-lambda/planner-review.mjs";

const LOCATION = "accounts/1234567890/locations/9876543210";
const ROOT = "/1---elettro-brand-os/brands/stashbox/band/image/4x3/";
const stashbox = { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: {} };
const NOW = new Date("2026-10-26T12:00:00Z");            // Monday 08:00 in New York
const asset = (n, over = {}) => ({ id: `a${n}`, filename: `stashbox_band_${"ABCF"[n % 4]}_x_${n}_4x3.jpg`, mimeType: "image/jpeg", fileSizeBytes: "600000", width: 1600, height: 1200, path: ROOT + `p${n}.jpg`, ...over });

function fake(handlers = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      for (const [match, rows] of Object.entries(handlers)) if (sql.includes(match)) return { rows: typeof rows === "function" ? rows(params) : rows, rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
}
const gmbAccount = (perWeek) => ({ socialAccountId: "sa-gmb", accountName: "Stashbox", publishingMode: "approval", postsPerWeek: perWeek });
const inserts = (c) => c.seen.filter((q) => q.sql.includes('INSERT INTO "ScheduledPost"'));
// What the publisher would receive for an inserted draft (claim-due-posts fields), so each draft is run through its real gates.
const asPublisherPost = (q, assets) => {
  const a = assets.find((x) => x.id === q.params[2]);
  const gmb = JSON.parse(q.params[5]).gmb;
  return { id: "p", brand: "stashbox", scheduledFor: q.params[3], caption: q.params[7], channelId: LOCATION, dropboxPath: a.path, assetMime: a.mimeType, assetBytes: a.fileSizeBytes, assetWidth: a.width, assetHeight: a.height, gmb };
};

test("the built-in pillar wording passes every publisher caption rule, and the buttons follow Dean's table", () => {
  for (const [slug, setup] of Object.entries(GMB_DEFAULTS)) {
    for (const [letter, p] of Object.entries(setup.pillars)) {
      for (const caption of p.captions) {
        assert.equal(captionProblem(caption), null, `${slug} ${letter}: ${caption}`);
        const post = { id: "p", brand: slug, scheduledFor: "2026-10-26T15:00:00Z", caption, channelId: LOCATION, dropboxPath: ROOT + "x.jpg", assetMime: "image/jpeg", assetBytes: 600000, assetWidth: 1600, assetHeight: 1200, gmb: { pillar: letter, topicType: "STANDARD", cta: p.cta } };
        assert.ok(postRequest(post, NOW), `${slug} ${letter} is accepted by the publisher`);
      }
    }
  }
  const s = GMB_DEFAULTS.stashbox.pillars;
  assert.deepEqual(s.A.cta, { actionType: "BOOK", url: "https://stashbox.com/booking" });
  assert.deepEqual(s.F.cta, { actionType: "LEARN_MORE", url: "https://stashbox.com/radio" });
  assert.deepEqual(Object.keys(GMB_DEFAULTS.elettro.pillars).sort(), ["B", "C"]);
});

test("brand setup: built-in wording, a settings override per pillar, and nothing for brands without pillars", () => {
  assert.deepEqual(Object.keys(gmbConfigFor(stashbox).pillars), ["A", "B", "C", "F"]);
  assert.equal(gmbConfigFor({ slug: "reggaeland", settings: {} }), null);
  assert.equal(gmbConfigFor({ slug: "solarmeister", settings: {} }), null);
  const own = gmbConfigFor({ slug: "reggaeland", settings: { gmb: { languageCode: "en-US", pillars: { A: { weight: 1, cta: { actionType: "BOOK", url: "https://reggae.land/book" }, captions: ["Live reggae for your resort night."] } } } } });
  assert.deepEqual(Object.keys(own.pillars), ["A"]);
  const over = gmbConfigFor({ slug: "stashbox", settings: { gmb: { pillars: { F: { weight: 0.1 } } } } });
  assert.equal(over.pillars.F.weight, 0.1);
  assert.equal(over.pillars.F.cta.url, "https://stashbox.com/radio", "the rest of the pillar keeps its built-in setup");
});

test("caption and URL checks agree with the publisher", () => {
  for (const text of ["Shop at stashbox.ai today", "Visit https://stashbox.com/radio", "See www.elettro.com", "Stashbox Shop is open", "Reggae.Land plays live", "A DJ, e.g. for a gala. Next week"]) {
    assert.equal(captionHasUrl(text), findUrl(text) !== null, text);
  }
  assert.equal(captionProblem(""), "empty");
  assert.match(captionProblem("x".repeat(1351)), /over 1350/);
  assert.match(captionProblem("Call 954.555.1234"), /phone/);
  assert.match(captionProblem("Book our BEST band"), /ALL CAPS/);
  assert.match(captionProblem("Visit stashbox.ai"), /URL/);
});

test("days spread across the week and the minute stays in the window and off the quarter hours", () => {
  assert.deepEqual(spreadDays([0, 1, 2, 3, 4, 5, 6], 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(spreadDays([0, 1, 2, 3, 4, 5, 6], 5), [0, 2, 3, 4, 6]);
  assert.deepEqual(spreadDays([0, 1, 2, 3, 4, 5, 6], 1), [3]);
  assert.deepEqual(spreadDays([4, 5, 6], 5), [4, 5, 6], "asks for more than there are days left: all of them");
  assert.deepEqual(spreadDays([], 3), []);
  for (let i = 0; i < 400; i++) {
    const m = slotMinute(`stashbox|2026-11-${i}`);
    assert.ok(m >= 600 && m <= 990 && m % 15 !== 0, String(m));
  }
  assert.equal(slotMinute("x", 1000, 990), null);
  assert.ok(slotMinute("x", 980, 990) >= 980);
});

test("the pillar mix keeps business pillars on top and fan content under half", () => {
  const w = { A: 0.45, B: 0.2, C: 0.15, F: 0.2 };
  const counts = {};
  const seq = [];
  for (let i = 0; i < 20; i++) { const p = nextPillar(counts, w, ["A", "B", "C", "F"]); seq.push(p); counts[p] = (counts[p] || 0) + 1; }
  assert.equal(counts.A + counts.B + counts.C > 10, true);
  assert.ok(counts.F <= 6 && counts.F >= 2, JSON.stringify(counts));
  assert.equal(nextPillar({ A: 1, F: 1 }, { F: 1 }, ["F"]), null, "fan only, already half: blocked");
  assert.equal(nextPillar({}, { A: 1, F: 0.5 }, ["A", "F"]), "A");
});

test("photos: JPG or PNG, 10 KB-5 MB, 1200x800 or more, and 4:3, 3:2 or 16:9; the filename can pin a pillar", () => {
  assert.equal(photoProblem(asset(1)), null);
  assert.equal(photoProblem(asset(1, { width: 1920, height: 1080 })), null);
  assert.equal(photoProblem(asset(1, { width: 1800, height: 1200 })), null);
  assert.match(photoProblem(asset(1, { width: 1600, height: 1600 })), /not 4:3, 3:2 or 16:9/);
  assert.match(photoProblem(asset(1, { width: 1000, height: 750 })), /under 1200x800/);
  assert.equal(photoProblem(asset(1, { width: null, height: null, mimeType: null })), null, "never measured: trusted from its 4x3 folder and the .jpg extension");
  assert.match(photoProblem(asset(1, { width: null, height: null, path: "/x/beach.jpg" })), /size unknown/);
  assert.match(photoProblem(asset(1, { width: null, height: null, mimeType: null, path: ROOT + "a.gif" })), /JPG or PNG/);
  assert.match(photoProblem(asset(1, { mimeType: "image/webp" })), /JPG or PNG/);
  assert.match(photoProblem(asset(1, { fileSizeBytes: "5000" })), /10 KB/);
  assert.equal(pillarOfFilename("stashbox_band_A_live-music-for-your-event_03_4x3.jpg"), "A");
  assert.equal(pillarOfFilename("stashbox_band_F_stashbox-live_01_4x3.jpg"), "F");
  assert.equal(pillarOfFilename("beach.jpg"), null);
  const photos = [{ id: "1", filename: "a", pillar: "A" }, { id: "2", filename: "b", pillar: "B" }, { id: "3", filename: "c", pillar: null }];
  assert.equal(pickPhoto(photos, "A", new Map(), new Set()).id, "1", "the pillar's own photo first");
  assert.equal(pickPhoto(photos, "A", new Map([["1", 5]]), new Set()).id, "3", "then the one not used yet");
  assert.equal(pickPhoto(photos, "A", new Map(), new Set(["1", "3"])), null, "a B photo never serves pillar A");
  assert.equal(pickCaption(["x", "y", "z"], ["x", "y"]), "z");
  assert.equal(pickCaption(["x", "y"], ["x", "y"]), "x", "everything used: the oldest");
});

test("a week of 5 posts a day-spread, each one passing the publisher's own validation", async () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(i + 1));
  const c = fake({ 'JOIN "CadenceRule"': [gmbAccount(5)], 'FROM "Asset"': assets });
  const r = await planGmbWeek(c, stashbox, { weekStart: "2026-10-26", now: NOW });
  assert.equal(r.planned, 5);
  const rows = inserts(c);
  assert.equal(rows.length, 5);
  const days = rows.map((q) => new Date(q.params[3]).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  assert.equal(new Set(days).size, 5, "one post a day at most");
  for (const q of rows) {
    assert.doesNotThrow(() => postRequest(asPublisherPost(q, assets), NOW), "the publisher accepts the draft");
    assert.match(q.sql, /'update'.*'planned'/s, "saved as a draft to review");
  }
  const pillars = rows.map((q) => JSON.parse(q.params[5]).gmb.pillar);
  assert.ok(pillars.filter((p) => p !== "F").length >= 3, "business pillars lead: " + pillars);
  assert.equal(new Set(rows.map((q) => q.params[2])).size, 5, "no photo twice in the week");
  assert.ok(c.seen.some((q) => q.sql === "BEGIN"));
  assert.ok(c.seen.at(-1).sql === "COMMIT");
  assert.ok(c.seen.some((q) => q.sql.includes('DELETE FROM "ScheduledPost"') && q.sql.includes("'planned'")), "this week's old drafts are replaced");
});

test("every post lands 9 AM-6 PM on the brand's own clock, any weekday, including the German time zone", async () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(i + 1));
  for (const [slug, tz] of [["stashbox", "America/New_York"]]) {
    const c = fake({ 'JOIN "CadenceRule"': [gmbAccount(7)], 'FROM "Asset"': assets });
    const r = await planGmbWeek(c, { ...stashbox, slug, timezone: tz }, { weekStart: "2026-11-02", now: NOW });   // across the clock change
    assert.equal(r.planned, 7);
    for (const q of inserts(c)) {
      const m = localMinutesOf(new Date(q.params[3]), tz);
      assert.ok(m >= 600 && m <= 990 && m % 15 !== 0, `${q.params[3]} -> ${m}`);
    }
  }
  const de = fake({ 'JOIN "CadenceRule"': [gmbAccount(3)], 'FROM "Asset"': assets });
  const own = { id: "b2", slug: "solarmeister", timezone: "Europe/Berlin", settings: { gmb: { languageCode: "de-DE", pillars: { B: { weight: 1, cta: { actionType: "LEARN_MORE", url: "https://solarmeister.de" }, captions: ["Solaranlagen fuer Ihr Zuhause, sauber geplant und gebaut."] } } } } };
  const r = await planGmbWeek(de, own, { weekStart: "2026-11-02", now: NOW });
  assert.equal(r.planned, 3);
  for (const q of inserts(de)) {
    const m = localMinutesOf(new Date(q.params[3]), "Europe/Berlin");
    assert.ok(m >= 600 && m <= 990);
    assert.equal(JSON.parse(q.params[5]).gmb.languageCode, "de-DE");
  }
});

test("days already holding a sent, approved, paused or removed post stay free of new drafts; today only gets a later time", async () => {
  const assets = Array.from({ length: 12 }, (_, i) => asset(i + 1));
  const history = [
    { assetId: "a1", status: "approved", scheduledFor: "2026-10-27T15:00:00Z", generatedCaption: "x", pillar: "A" },
    { assetId: "a2", status: "published", scheduledFor: "2026-10-28T15:00:00Z", generatedCaption: "y", pillar: "B" },
    { assetId: "a3", status: "removed", scheduledFor: "2026-10-29T15:00:00Z", generatedCaption: "z", pillar: "A" },
    { assetId: "a4", status: "skipped", scheduledFor: "2026-10-30T15:00:00Z", generatedCaption: "w", pillar: "A" }
  ];
  const c = fake({ 'JOIN "CadenceRule"': [gmbAccount(7)], 'FROM "Asset"': assets, 'FROM "ScheduledPost" sp WHERE': history });
  const r = await planGmbWeek(c, stashbox, { weekStart: "2026-10-26", now: new Date("2026-10-26T20:00:00Z") });   // Monday 16:00 in New York
  const days = inserts(c).map((q) => new Date(q.params[3]).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  for (const taken of ["2026-10-27", "2026-10-28", "2026-10-29"]) assert.ok(!days.includes(taken), taken);
  assert.ok(days.includes("2026-10-30"), "a skipped post leaves its day free");
  assert.equal(r.planned, 3, "Friday, Saturday and Sunday are the free days");
  assert.deepEqual(days, ["2026-10-30", "2026-10-31", "2026-11-01"]);
  // Monday 16:00: too late for a post that day (window ends 16:30, lead time 45 minutes), so it asks no day for it
  assert.ok(!days.includes("2026-10-26"));
  // fewer posts than free days: a late Monday gives its post to a later day instead of losing it
  const c2 = fake({ 'JOIN "CadenceRule"': [gmbAccount(2)], 'FROM "Asset"': assets });
  const r2 = await planGmbWeek(c2, stashbox, { weekStart: "2026-10-26", now: new Date("2026-10-26T20:00:00Z") });
  assert.equal(r2.planned, 2);
});

test("when there is nothing to plan, it says why and writes nothing", async () => {
  const none = fake({ 'JOIN "CadenceRule"': [] });
  assert.match((await planGmbWeek(none, stashbox, { weekStart: "2026-10-26", now: NOW })).message, /no posts per day set/);
  assert.equal(inserts(none).length, 0);
  const noPillars = fake({ 'JOIN "CadenceRule"': [gmbAccount(3)] });
  assert.match((await planGmbWeek(noPillars, { id: "b9", slug: "reggaeland", timezone: "America/New_York", settings: {} }, { weekStart: "2026-10-26", now: NOW })).message, /no pillar wording yet/);
  const noPhotos = fake({ 'JOIN "CadenceRule"': [gmbAccount(3)], 'FROM "Asset"': [asset(1, { width: 1080, height: 1920 }), asset(2, { mimeType: "image/webp" })] });
  const r = await planGmbWeek(noPhotos, stashbox, { weekStart: "2026-10-26", now: NOW });
  assert.equal(r.planned, 0);
  assert.match(r.message, /no usable photos.*2 rejected/);
  assert.equal(r.rejectedPhotos, 2);
  assert.equal(inserts(noPhotos).length, 0);
});

test("a photo pinned to one pillar is used only for it", async () => {
  const onlyA = [asset(4, { filename: "stashbox_band_A_live_01_4x3.jpg" }), asset(8, { filename: "stashbox_band_A_live_02_4x3.jpg" })];
  const c = fake({ 'JOIN "CadenceRule"': [gmbAccount(4)], 'FROM "Asset"': onlyA });
  const r = await planGmbWeek(c, stashbox, { weekStart: "2026-10-26", now: NOW });
  assert.equal(r.planned, 2, "only two photos exist and both are pillar A");
  for (const q of inserts(c)) assert.equal(JSON.parse(q.params[5]).gmb.pillar, "A");
});

test("Review's Plan button plans Google Business too, alone or next to the other networks", async () => {
  process.env.CONNECTIONS_API_SHARED_SECRET = "k".repeat(40);
  const event = { headers: { "x-elettro-connect-key": "k".repeat(40) } };
  const json = (statusCode, body) => ({ statusCode, body });
  const assets = Array.from({ length: 8 }, (_, i) => asset(i + 1));
  const brandRow = { id: "brand-1", slug: "stashbox", timezone: "America/New_York", settings: { planner: { sectors: [{ id: "live" }] } } };
  const make = (connected) => {
    const c = fake({ 'FROM "Brand"': [brandRow], 'SELECT DISTINCT "destination"': connected.map((destination) => ({ destination })), 'JOIN "CadenceRule"': [gmbAccount(3)], 'FROM "Asset"': assets });
    return c;
  };
  const invoked = [];
  const deps = { invoke: async (p) => { invoked.push(p); }, readSeed: () => "{}", now: new Date("2026-10-20T15:00:00Z") };
  const only = make(["gmb"]);
  const a = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26" }, async () => only, json, deps);
  assert.equal(a.statusCode, 200);
  assert.equal(a.body.planning, false);
  assert.equal(a.body.gmb.planned, 3);
  assert.equal(invoked.length, 0, "nothing else to plan");
  const both = make(["gmb", "instagram"]);
  const b = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26" }, async () => both, json, deps);
  assert.equal(b.statusCode, 202);
  assert.equal(b.body.gmb.planned, 3);
  assert.deepEqual(invoked.at(-1).destinations, ["instagram"], "gmb is never handed to planner-v2");
  const named = make(["gmb", "instagram"]);
  const c = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26", destinations: ["instagram"] }, async () => named, json, deps);
  assert.equal(c.body.gmb, undefined, "only asked-for networks are planned");
  const none = make(["facebook_none"]);
  const d = await handlePlannerReview(event, { brand: "stashbox", action: "plan", weekStart: "2026-10-26" }, async () => none, json, deps);
  assert.equal(d.statusCode, 409);
});
