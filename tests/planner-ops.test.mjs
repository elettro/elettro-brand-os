import test from "node:test";
import assert from "node:assert/strict";
import { weekToPlan, handlePlannerWeb, handlePlannerOps, recordingDateOf, brandLocation, youtubeTagsFor, youtubeTagLength, YOUTUBE_TAG_BUDGET } from "../services/dev-api-lambda/planner-ops.mjs";
import { weekWindow } from "../services/dev-api-lambda/planner-v2-db.mjs";
import { addDaysToYmd, brandLanguage, languageOf } from "../services/dev-api-lambda/planner-v2.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const KEY = "k".repeat(40);
process.env.CONNECTIONS_API_SHARED_SECRET = KEY;

const brand = { id: "b1", slug: "stashbox", timezone: "America/New_York", settings: { planner: {} } };
const nextWeek = weekWindow(brand, null).weekStart;

test("the tick plans next week first, then the week after, then rests", () => {
  const weekAfter = addDaysToYmd(nextWeek, 7);
  assert.deepEqual(weekToPlan(brand, { youtube: [] }), { weekStart: nextWeek, replace: false, destinations: ["youtube"] });
  assert.deepEqual(weekToPlan(brand, { youtube: [nextWeek] }), { weekStart: weekAfter, replace: false, destinations: ["youtube"] });
  assert.equal(weekToPlan(brand, { youtube: [nextWeek, weekAfter] }), null);
  assert.equal(weekToPlan(brand, {}), null);
});

test("a week planned for some networks is still planned for the others, and only for them", () => {
  // The Review page planned next week for Instagram + Facebook; YouTube and TikTok still need it.
  const planned = { instagram: [nextWeek], facebook: [nextWeek], youtube: [], tiktok: [] };
  assert.deepEqual(weekToPlan(brand, planned), { weekStart: nextWeek, replace: false, destinations: ["tiktok", "youtube"] });
});

test("the tick asks the planner for just the networks missing from the week", async () => {
  let cadenceParams;
  const db = async () => ({
    async query(sql, params) {
      if (sql.includes('SELECT DISTINCT b."slug"')) return { rows: [{ slug: "stashbox" }] };
      if (sql.includes('FROM "Brand"')) return { rows: [{ ...brand, settings: { planner: { sectors: [{ id: "live" }] } } }] };
      if (sql.includes('SELECT DISTINCT sa."destination" FROM')) return { rows: [{ destination: "instagram" }, { destination: "youtube" }] };
      if (sql.includes('AS "week"')) return { rows: [{ destination: "instagram", week: nextWeek }] };
      if (sql.includes('FROM "CadenceRule" cr JOIN')) { cadenceParams = params; return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
    async end() {}
  });
  const r = await handlePlannerOps({ action: "planner-tick" }, db, json);
  assert.deepEqual(cadenceParams?.[1], ["youtube"]);
  assert.deepEqual(r.body.destinations, ["youtube"]);
});

test("a re-plan the page asked for wins, and replaces that week's unapproved posts on every network", () => {
  const asked = { ...brand, settings: { plannerRuntime: { replanWeek: "2026-11-02" } } };
  assert.deepEqual(weekToPlan(asked, { youtube: [nextWeek] }), { weekStart: "2026-11-02", replace: true, destinations: null });
});

test("the planner page needs the owner key", async () => {
  const r = await handlePlannerWeb({ headers: {} }, { action: "view", brandSlug: "stashbox" }, () => { throw new Error("no db"); }, json);
  assert.equal(r.statusCode, 401);
});

test("cadence edits must be whole numbers from 0 to 200 per week", async () => {
  const event = { headers: { "x-elettro-connect-key": KEY } };
  const db = () => { throw new Error("should not reach the database"); };
  for (const postsPerWeek of [-1, 201, 2.5, "7"]) {
    const r = await handlePlannerWeb(event, { action: "set-cadence", brandSlug: "stashbox", rules: [{ id: "r1", postsPerWeek }] }, db, json);
    assert.equal(r.statusCode, 400, `postsPerWeek ${postsPerWeek}`);
  }
});

test("finish-post with a video id publishes and writes the ledger in one transaction", async () => {
  const sql = [];
  const client = {
    query: async (text) => { sql.push(text.trim().split(/\s+/).slice(0, 3).join(" ")); return { rowCount: 1, rows: [{ id: "p1" }] }; },
    end: async () => {}
  };
  const r = await handlePlannerOps({ action: "finish-post", id: "p1", externalPostId: "W9p6rHwRgHQ", externalUrl: "https://youtu.be/W9p6rHwRgHQ" },
    async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sql, ["BEGIN", "UPDATE \"ScheduledPost\" SET", "INSERT INTO \"PublicationLedger\"", "COMMIT"]);
});

test("claim-due-posts only marks missed or stuck posts for its own destination", async () => {
  const queries = [];
  const client = { query: async (text, values) => { queries.push({ text, values }); return { rowCount: 0, rows: [] }; }, end: async () => {} };
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  const updates = queries.filter((q) => /SET "status" = 'missed'|never reported back/.test(q.text));
  assert.equal(updates.length, 2);
  for (const q of updates) assert.match(q.text, /sa\."destination" = \$1/);
  // The stuck sweep also carries whether this worker wants one retry (YouTube does not).
  assert.deepEqual(updates.map((q) => q.values), [["youtube"], ["youtube", false]]);
});

test("claimed posts carry the AI flag from the clip's own tags, or from the planner", async () => {
  const rows = [
    { id: "p1", brandId: "b1", assetTags: ["seedance", "AI-Generated"], plannedSynthetic: "false" },
    { id: "p2", brandId: "b1", assetTags: ["studio-session"], plannedSynthetic: "true" },
    { id: "p3", brandId: "b1", assetTags: ["studio-session"], plannedSynthetic: null }
  ];
  const client = {
    query: async (text) => {
      if (text.includes("RETURNING sp.\"id\"")) return { rowCount: 3, rows };
      if (text.includes('FROM "Brand"')) return { rows: [{ settings: { planner: { syntheticTagsAny: ["ai-generated"] } } }] };
      return { rowCount: 0, rows: [] };
    },
    end: async () => {}
  };
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "youtube" }, async () => client, json);
  assert.deepEqual(r.body.posts.map((p) => [p.id, p.synthetic]), [["p1", true], ["p2", true], ["p3", false]]);
  assert.ok(r.body.posts.every((p) => p.paidPromotion === false), "no clip is tagged paid-promotion");
  assert.ok(!("assetTags" in r.body.posts[0]) && !("brandId" in r.body.posts[0]));
});

test("a clip is English unless a tag names another language; bare two-letter tags don't count", () => {
  assert.equal(languageOf({ tags: ["stashbox", "reggae"] }), "en");
  assert.equal(languageOf({ tags: [] }), "en");
  assert.equal(languageOf({ tags: ["podcast", "German"] }), "de");
  assert.equal(languageOf({ tags: ["lang:es"] }), "es");
  assert.equal(languageOf({ tags: ["language:french"] }), "fr");
  assert.equal(languageOf({ tags: ["language-deutsch"] }), "de");
  assert.equal(languageOf({ tags: ["de", "es"] }), "en");
  assert.equal(languageOf({ tags: ["lang:xx"] }), "en");
});

test("German brands default to German, and a clip tag still overrides the brand", () => {
  assert.equal(brandLanguage("solarmeister", {}), "de");
  assert.equal(brandLanguage("neckermann-strom", null), "de");
  assert.equal(brandLanguage("stashbox", {}), "en");
  assert.equal(brandLanguage("stashbox", { language: "es" }), "es");
  assert.equal(languageOf({ tags: ["solar"] }, "de"), "de");
  assert.equal(languageOf({ tags: ["english"] }, "de"), "en");
});

test("a clip's recording date is its filename's YYMMDD session date, else today", () => {
  const today = "2026-10-21";
  assert.equal(recordingDateOf("261011-stashbox-does-dylan-tangled-up-in-blue-9x16-4K-05.mp4", today), "2026-10-11");
  assert.equal(recordingDateOf("260930_session-clip.mp4", today), "2026-09-30");
  assert.equal(recordingDateOf("stashbox-does-sublime-promo-ai-montage-wan3-9x16-v7.mp4", today), today);
  assert.equal(recordingDateOf("261399-bad-date.mp4", today), today, "not a real date");
  assert.equal(recordingDateOf("271231-future.mp4", today), today, "not in the future");
  assert.equal(recordingDateOf(null, today), today);
});

test("a brand location is used only when it has coordinates", () => {
  assert.equal(brandLocation({}), null);
  assert.equal(brandLocation({ location: { description: "Stashbox" } }), null);
  assert.deepEqual(brandLocation({ location: { latitude: 26.07, longitude: -80.27, description: "Stashbox" } }),
    { latitude: 26.07, longitude: -80.27, description: "Stashbox" });
});

test("YouTube counts commas and the quotes around multi-word tags", () => {
  assert.equal(youtubeTagLength([]), 0);
  assert.equal(youtubeTagLength(["reggae"]), 6);
  assert.equal(youtubeTagLength(["reggae", "live band"]), 6 + 1 + 9 + 2);
});

test("YouTube tags fill just under 500 characters, most specific first, never internal tags", () => {
  const tags = youtubeTagsFor({
    hashtags: ["#stashbox", "#bobdylan"], topic: "Visions of Johanna", sector: "live-shows", brandSlug: "stashbox",
    assetTags: ["song:visions-of-johanna", "original-artist:bob-dylan", "stashbox-does-dylan", "cover", "9x16", "hd-1080",
      "visual:crowd", "ready-to-publish", "player:dean-palermo", "album:stashbox-does-dylan-vol-1"]
  });
  const length = youtubeTagLength(tags);
  assert.ok(length <= YOUTUBE_TAG_BUDGET && length > 400, `tag box uses ${length} characters`);
  assert.deepEqual(tags.slice(0, 5), ["stashbox", "bobdylan", "visions of johanna", "visions of johanna bob dylan", "bob dylan"]);
  assert.ok(tags.includes("visions of johanna cover") && tags.includes("dean palermo") && tags.includes("book a band"));
  for (const internal of ["9x16", "hd-1080", "hd 1080", "visual:crowd", "ready-to-publish", "cover"]) assert.ok(!tags.includes(internal), internal);
  assert.equal(new Set(tags).size, tags.length, "no duplicates");
});

test("a brand's own keyword list replaces the built-in one; German brands get German keywords", () => {
  assert.ok(youtubeTagsFor({ brandSlug: "stashbox", brandKeywords: ["only this"] }).includes("only this"));
  assert.ok(!youtubeTagsFor({ brandSlug: "stashbox", brandKeywords: ["only this"] }).includes("south florida band"));
  assert.ok(youtubeTagsFor({ brandSlug: "solarmeister" }).includes("photovoltaik"));
});

test("finish-post without a video id marks the post failed and keeps the error", async () => {
  let params;
  const client = { query: async (_text, values) => { params = values; return { rowCount: 1, rows: [] }; }, end: async () => {} };
  const r = await handlePlannerOps({ action: "finish-post", id: "p1", error: "quota exceeded" }, async () => client, json);
  assert.equal(r.body.status, "failed");
  assert.match(params[1], /quota exceeded/);
});
