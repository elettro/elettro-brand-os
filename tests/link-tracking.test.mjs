import test from "node:test";
import assert from "node:assert/strict";
import {
  newCode, CODE_PATTERN, isBot, trackingConfig, taggedUrl, planPostLink, trackClaimedPosts,
  recordClick, recordEvent, handleLinks, runLinkTrackingSetup
} from "../services/dev-api-lambda/link-tracking.mjs";
import { handlePlannerOps } from "../services/dev-api-lambda/planner-ops.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const settings = { linkTracking: { enabled: true, host: "go.stashbox.ai" }, planner: { links: { merchStore: "https://stashbox.ai", site: "https://stashbox.com" } } };
const config = trackingConfig(settings);

test("codes are 7 characters with no look-alike letters", () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), CODE_PATTERN);
  assert.equal(CODE_PATTERN.test("abc0O1l"), false);
});

test("tracking is off unless the brand turns it on with a host", () => {
  assert.equal(trackingConfig({}), null);
  assert.equal(trackingConfig({ linkTracking: { enabled: false, host: "go.stashbox.ai" } }), null);
  assert.equal(trackingConfig({ linkTracking: { enabled: true } }), null);
  assert.deepEqual(config, { host: "go.stashbox.ai", origins: ["https://stashbox.ai", "https://stashbox.com"] });
  assert.deepEqual(trackingConfig({ ...settings, linkTracking: { enabled: true, host: "go.stashbox.ai", origins: ["https://stashbox.ai/x"] } }).origins, ["https://stashbox.ai"]);
});

test("a caption link to the store becomes the short link, and the caption never grows", () => {
  const post = { destination: "threads", caption: "New tee is in. https://stashbox.ai/products/night-nurse-tee", primaryLink: "https://stashbox.ai/products/night-nurse-tee", sector: "merch" };
  const c = planPostLink(post, config, "Ab3x9K7");
  assert.equal(c.caption, "New tee is in. https://go.stashbox.ai/Ab3x9K7");
  assert.equal(c.primaryLink, "https://go.stashbox.ai/Ab3x9K7");
  assert.equal(c.targetUrl, "https://stashbox.ai/products/night-nurse-tee");
  // A sentence-ending full stop stays outside the link.
  assert.equal(planPostLink({ ...post, caption: "Shop: https://stashbox.ai/products/night-nurse-tee." }, config, "Ab3x9K7").caption, "Shop: https://go.stashbox.ai/Ab3x9K7.");
  // A short store root would get longer: left alone.
  assert.equal(planPostLink({ ...post, caption: "Shop https://stashbox.ai" }, config, "Ab3x9K7"), null);
});

test("links to other sites, already-tracked links and posts with no link are left alone", () => {
  assert.equal(planPostLink({ destination: "bluesky", caption: "Listen https://open.spotify.com/artist/0QMZNPEj7A2MFnT9zJGERa" }, config, "Ab3x9K7"), null);
  assert.equal(planPostLink({ destination: "bluesky", caption: "Shop https://go.stashbox.ai/Zz9x9K7 now" }, config, "Ab3x9K7"), null);
  assert.equal(planPostLink({ destination: "x", caption: "No links on X" }, config, "Ab3x9K7"), null);
  assert.equal(planPostLink({ destination: "bluesky", caption: "x" }, null, "Ab3x9K7"), null);
});

test("Pinterest and GMB keep the store address and only gain the code", () => {
  const pin = planPostLink({ destination: "pinterest", caption: "Tap the Pin.", primaryLink: "https://stashbox.ai/products/tee", placement: "pin" }, config, "Ab3x9K7");
  assert.equal(pin.caption, undefined);
  assert.equal(new URL(pin.primaryLink).pathname, "/products/tee");
  assert.equal(new URL(pin.primaryLink).searchParams.get("eo"), "Ab3x9K7");
  const gmb = planPostLink({ destination: "gmb", gmb: { cta: { actionType: "SHOP", url: "https://stashbox.ai/products/tee" } } }, config, "Ab3x9K7");
  assert.equal(new URL(gmb.gmbUrl).pathname, "/products/tee");
  assert.equal(new URL(gmb.gmbUrl).searchParams.get("utm_source"), "gmb");
  assert.equal(planPostLink({ destination: "gmb", gmb: { cta: { url: gmb.gmbUrl } } }, config, "Ab3x9K7"), null, "a retry does not tag twice");
});

test("the real address carries the code and utm fields for Shopify", () => {
  const u = new URL(taggedUrl("https://stashbox.ai/products/tee?variant=1", { code: "Ab3x9K7", destination: "threads", campaign: "Live Shows" }));
  assert.deepEqual(Object.fromEntries(u.searchParams), { variant: "1", eo: "Ab3x9K7", utm_source: "threads", utm_medium: "social", utm_campaign: "live-shows", utm_content: "Ab3x9K7" });
});

test("preview robots and empty user agents are not clicks", () => {
  assert.equal(isBot("Mastodon/4.3.0 (http.rb/5.2.0; +https://mastodon.social/)"), true);
  assert.equal(isBot("facebookexternalhit/1.1"), true);
  assert.equal(isBot(""), true);
  assert.equal(isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0"), false);
});

function fakeDb(handlers = {}) {
  const queries = [];
  return {
    queries,
    client: {
      query: async (text, values) => {
        queries.push({ text, values });
        for (const [needle, rows] of Object.entries(handlers)) if (text.includes(needle)) return typeof rows === "function" ? rows(text, values) : { rows, rowCount: rows.length };
        return { rows: [], rowCount: 1 };
      },
      end: async () => {}
    }
  };
}

test("claiming a post records its link, rewrites the caption and saves the change", async () => {
  const { client, queries } = fakeDb();
  const posts = [{ id: "p1", brandId: "b1", destination: "threads", placement: "post", caption: "Tee https://stashbox.ai/products/night-nurse-tee", primaryLink: "https://stashbox.ai/products/night-nurse-tee" }];
  const n = await trackClaimedPosts(client, posts, new Map([["b1", settings]]), { makeCode: () => "Ab3x9K7" });
  assert.equal(n, 1);
  assert.equal(posts[0].caption, "Tee https://go.stashbox.ai/Ab3x9K7");
  assert.equal(posts[0].trackingCode, "Ab3x9K7");
  const insert = queries.find((q) => q.text.includes('INSERT INTO "TrackedLink"'));
  assert.deepEqual(insert.values, ["Ab3x9K7", "b1", "p1", "threads", "post", "https://stashbox.ai/products/night-nurse-tee", "short"]);
  const update = queries.find((q) => q.text.includes('UPDATE "ScheduledPost"'));
  assert.equal(update.values[1], "Tee https://go.stashbox.ai/Ab3x9K7");
});

test("a failing database never stops the post", async () => {
  const client = { query: async () => { throw new Error("db down"); } };
  const posts = [{ id: "p1", brandId: "b1", destination: "threads", caption: "Tee https://stashbox.ai/products/night-nurse-tee-long" }];
  const n = await trackClaimedPosts(client, posts, new Map([["b1", settings]]), { log: { error() {} } });
  assert.equal(n, 0);
  assert.equal(posts[0].caption, "Tee https://stashbox.ai/products/night-nurse-tee-long");
});

test("brands without tracking are not touched by claim-due-posts", async () => {
  const { client, queries } = fakeDb({
    'RETURNING sp."id"': [{ id: "p1", brandId: "b1", caption: "Tee https://stashbox.ai/products/night-nurse-tee", primaryLink: null, assetTags: [] }],
    'FROM "Brand"': [{ slug: "stashbox", settings: { planner: {} } }]
  });
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "threads" }, async () => client, json);
  assert.equal(r.body.posts[0].caption, "Tee https://stashbox.ai/products/night-nurse-tee");
  assert.ok(!("destination" in r.body.posts[0]));
  assert.ok(!queries.some((q) => q.text.includes("TrackedLink")));
});

test("claim-due-posts hands out the short link for a tracked brand", async () => {
  const { client } = fakeDb({
    'RETURNING sp."id"': [{ id: "p1", brandId: "b1", placement: "post", caption: "Tee https://stashbox.ai/products/night-nurse-tee", primaryLink: null, assetTags: [] }],
    'FROM "Brand"': [{ slug: "stashbox", settings }],
    'SELECT "code" FROM "TrackedLink"': []
  });
  const r = await handlePlannerOps({ action: "claim-due-posts", destination: "threads" }, async () => client, json);
  assert.match(r.body.posts[0].caption, /^Tee https:\/\/go\.stashbox\.ai\/[2-9a-zA-Z]{7}$/);
});

test("a click is counted and answered with the tagged store address; robots count as previews", async () => {
  const link = [{ id: "l1", brandId: "b1", destination: "threads", targetUrl: "https://stashbox.ai/products/tee", sector: "merch", placement: "post" }];
  const human = fakeDb({ 'FROM "TrackedLink" tl': link });
  const tap = { code: "Ab3x9K7", method: "GET", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1", referrer: "https://l.threads.net/xyz", acceptLanguage: "en-US,en;q=0.9", secFetchMode: "navigate", secFetchDest: "document" };
  const [status, body] = await recordClick(human.client, tap);
  assert.equal(status, 200);
  assert.equal(body.kind, "click");
  assert.equal(new URL(body.location).searchParams.get("eo"), "Ab3x9K7");
  assert.deepEqual(human.queries.at(-1).values, ["l1", "b1", "click", "l.threads.net", "GET ios safari lang fetch:navigate"]);
  const bot = fakeDb({ 'FROM "TrackedLink" tl': link });
  assert.equal((await recordClick(bot.client, { code: "Ab3x9K7", userAgent: "Mastodon/4.3" }))[1].kind, "preview");
  assert.equal((await recordClick(fakeDb({ 'FROM "TrackedLink" tl': [] }).client, { code: "Ab3x9K7" }))[0], 404);
  assert.equal((await recordClick(human.client, { code: "../../etc" }))[0], 404);
});

test("store events need a known code and a known kind; values are cleaned", async () => {
  const db = fakeDb({ 'SELECT "id", "brandId" FROM "TrackedLink"': [{ id: "l1", brandId: "b1" }] });
  const [status, body] = await recordEvent(db.client, { code: "Ab3x9K7", kind: "purchase", value: "54.999", currency: "USD", product: "Night Nurse Tee", eventId: "sh-123" });
  assert.equal(status, 200);
  assert.equal(body.recorded, true);
  assert.deepEqual(db.queries.at(-1).values, ["l1", "b1", "purchase", "Night Nurse Tee", 55, "USD", "sh-123"]);
  assert.equal((await recordEvent(db.client, { code: "Ab3x9K7", kind: "click" }))[0], 400, "the pixel cannot fake clicks");
  assert.equal((await recordEvent(db.client, { code: "Ab3x9K7", kind: "purchase", value: -5, currency: "usd" }))[0], 200);
  assert.deepEqual(db.queries.at(-1).values.slice(4, 6), [null, null]);
  assert.equal((await recordEvent(fakeDb({}).client, { code: "Ab3x9K7", kind: "page_view" }))[1].ignored, "unknown code");
});

test("the /links route only knows click, event and stats", async () => {
  const r = await handleLinks({ action: "drop-tables" }, async () => fakeDb().client, json);
  assert.equal(r.statusCode, 400);
});

test("setup is IAM only, a dry run by default, and needs a host with a brand", async () => {
  assert.equal((await runLinkTrackingSetup({ rawPath: "/x" }, async () => fakeDb().client, json)).statusCode, 403);
  assert.equal((await runLinkTrackingSetup({ brandSlug: "stashbox" }, async () => fakeDb().client, json)).statusCode, 400);
  const db = fakeDb({ "information_schema.tables": [], 'FROM "Brand"': [{ id: "b1", settings: { planner: { links: { merchStore: "https://stashbox.ai" } } } }] });
  const dry = await runLinkTrackingSetup({ brandSlug: "stashbox", host: "go.stashbox.ai" }, async () => db.client, json);
  assert.equal(dry.body.mode, "dry-run");
  assert.deepEqual(dry.body.effective, { host: "go.stashbox.ai", origins: ["https://stashbox.ai"] });
  assert.ok(!db.queries.some((q) => /CREATE TABLE|UPDATE "Brand"/.test(q.text)));
  const apply = await runLinkTrackingSetup({ mode: "apply", brandSlug: "stashbox", host: "go.stashbox.ai" }, async () => db.client, json);
  assert.equal(apply.statusCode, 200);
  assert.ok(db.queries.some((q) => q.text.includes('CREATE TABLE IF NOT EXISTS "LinkEvent"')));
  assert.ok(db.queries.some((q) => q.text.includes('UPDATE "Brand"') && q.values[1] === JSON.stringify({ enabled: true, host: "go.stashbox.ai" })));
});

test("only a real page open counts as a click: HEAD, prefetch, no languages and link checkers do not", async () => {
  const { isHumanOpen } = await import("../services/dev-api-lambda/link-tracking.mjs");
  const phone = { method: "GET", userAgent: "Mozilla/5.0 (iPhone) AppleWebKit Mobile Safari/604.1", acceptLanguage: "en-US", secFetchMode: "navigate", secFetchDest: "document" };
  assert.equal(isHumanOpen(phone), true);
  assert.equal(isHumanOpen({ ...phone, secFetchMode: "", secFetchDest: "" }), true, "older Safari sends no sec-fetch headers");
  assert.equal(isHumanOpen({ ...phone, method: "HEAD" }), false);
  assert.equal(isHumanOpen({ ...phone, purpose: "prefetch" }), false);
  assert.equal(isHumanOpen({ ...phone, acceptLanguage: "" }), false, "scanners rarely send languages");
  assert.equal(isHumanOpen({ ...phone, secFetchMode: "no-cors", secFetchDest: "image" }), false);
  assert.equal(isHumanOpen({ ...phone, userAgent: "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1)" }), false);
});

test("the events list shows each event with its client label", async () => {
  const { linkEvents } = await import("../services/dev-api-lambda/link-tracking.mjs");
  const db = fakeDb({ 'FROM "LinkEvent" e': [{ createdAt: "t", kind: "click", referrerHost: null, client: "GET ios safari lang fetch:navigate" }] });
  const [status, body] = await linkEvents(db.client, { code: "Ab3x9K7" });
  assert.equal(status, 200);
  assert.equal(body.events.length, 1);
  assert.equal((await linkEvents(db.client, { code: "bad" }))[0], 400);
});
