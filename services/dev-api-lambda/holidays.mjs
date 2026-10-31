/**
 * Holidays (Review-style drafts for a date every year, starting with Halloween). Routed through
 * POST /planner/review like the other review actions.
 *
 *   holiday-list     the brand's drafts for one holiday (3 per brand), with the picture, swap choices and,
 *                    for approved ones, where and when they were scheduled
 *   holiday-edit     rewrite a draft's caption and hashtags
 *   holiday-skip     skip (or bring back) a draft
 *   holiday-swap     use another Halloween picture of the brand
 *   holiday-approve  Dean's rule: approving moves a draft into its date's plan of active posts. One
 *                    approved ScheduledPost per connected network (HOLIDAY_DESTINATIONS), on the holiday.
 *
 * Drafts live in Brand.settings.holidays.<key>.drafts (seeded from this file the first time a brand is
 * opened). No year appears in any caption. German brands get German. Pictures are the brand's own
 * library assets named <brand>_halloween_<n>_4x5.jpg; a draft whose picture is not registered yet
 * cannot be approved.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { localDateTimeToUtc, ymdInTimeZone, addDaysToYmd } from "./planner-v2.mjs";

export const HOLIDAYS = { halloween: { name: "Halloween", month: 10, day: 31 } };
// Networks that take one photo with text today. LinkedIn, Pinterest, TikTok, YouTube and GMB are left out on purpose.
export const HOLIDAY_DESTINATIONS = ["instagram", "facebook", "threads", "bluesky", "mastodon"];
export const HOLIDAY_BRAND_SLUGS = ["stashbox", "elettro", "solarmeister", "neckermann-strom", "weightlossdavie", "therasbox", "pianomusicsoothing", "deanpalermo", "rompe", "reggaeland"];

const EN_TAGS = ["Halloween", "HappyHalloween"];
// brand -> [caption, hashtags] x3. German brands in German.
export const HALLOWEEN_COPY = {
  stashbox: [
    ["Trick or treat yourself to some live music. Happy Halloween from all of us at Stashbox! 🎃🎸", ["Halloween", "LiveMusic", "Stashbox"]],
    ["Turn it up, it's spooky season. Happy Halloween! 🎃", ["Halloween", "SpookySeason", "Stashbox"]],
    ["Something wicked this way comes... and it's loud. Happy Halloween from Stashbox! 👻", ["Halloween", "LiveMusic", "Stashbox"]]
  ],
  elettro: [
    ["Happy Halloween from Elettro. No tricks, just treats. 🎃", ["Halloween", "Elettro"]],
    ["Lights on, pumpkins glowing. Happy Halloween from all of us at Elettro. 🎃", ["Halloween", "HappyHalloween", "Elettro"]],
    ["Stay spooky. Happy Halloween! 👻", ["Halloween", "Elettro"]]
  ],
  solarmeister: [
    ["Frohes Halloween! Ihr SolarMeister wünscht gruselig schöne Grüße. 🎃", ["Halloween", "FrohesHalloween", "SolarMeister"]],
    ["Ein sonniges Halloween wünscht Ihr SolarMeister! ☀️🎃", ["Halloween", "SolarMeister"]],
    ["Schaurig schöne Grüße zu Halloween von Ihrem SolarMeister. 👻", ["Halloween", "Gruselig", "SolarMeister"]]
  ],
  "neckermann-strom": [
    ["Frohes Halloween! Schaurig schöne Grüße von Neckermann Strom. 🎃", ["Halloween", "FrohesHalloween", "NeckermannStrom"]],
    ["Gruselige Grüße zu Halloween von Neckermann Strom! 👻", ["Halloween", "NeckermannStrom"]],
    ["Wir wünschen Ihnen ein spannendes Halloween! 🎃", ["Halloween", "NeckermannStrom"]]
  ],
  weightlossdavie: [
    ["Happy Halloween! Enjoy the treats. We reset tomorrow. 🎃", ["Halloween", "WeightLossDavie"]],
    ["Happy Halloween. Be good (ish). 🎃", ["Halloween", "WeightLossDavie"]],
    ["Trick or treat. Then trick or train. 👻", ["Halloween", "WeightLossDavie"]]
  ],
  therasbox: [
    ["A little spooky, a lot of fun. Happy Halloween from Therasbox! 🎃", ["Halloween", "Therasbox"]],
    ["Wishing you a cozy, spooky night. Happy Halloween! 🎃", ["Halloween", "HappyHalloween", "Therasbox"]],
    ["Boo! Take a deep breath. Happy Halloween. 👻", ["Halloween", "Therasbox"]]
  ],
  pianomusicsoothing: [
    ["A quiet, candlelit night of piano. Happy Halloween. 🕯️🎃", ["Halloween", "PianoMusic", "Relaxing"]],
    ["Soft keys for a spooky evening. Happy Halloween. 🎹", ["Halloween", "PianoMusic", "Relaxing"]],
    ["Gentle music for the longest night. Happy Halloween. 🎃", ["Halloween", "PianoMusic"]]
  ],
  deanpalermo: [
    ["Don't be scared. It's just music. Happy Halloween! 🎃", ["Halloween", "DeanPalermo"]],
    ["Trick or treat. Then turn it up. 🎸", ["Halloween", "DeanPalermo"]],
    ["Happy Halloween from me to you! 👻", ["Halloween", "HappyHalloween"]]
  ],
  rompe: [
    ["Break the night open. Happy Halloween. 🎃", ["Halloween", "Rompe"]],
    ["Not a night for sleeping. Happy Halloween! 👻", ["Halloween", "Rompe"]],
    ["Rompe the dark. Happy Halloween. 🎃", ["Halloween", "Rompe"]]
  ],
  reggaeland: [
    ["Irie Halloween! 🎃", ["Halloween", "ReggaeLand"]],
    ["Spooky vibes. One love. Happy Halloween! 👻", ["Halloween", "ReggaeLand"]],
    ["Good vibes only. Even the ghosts. Happy Halloween! 🎃", ["Halloween", "ReggaeLand"]]
  ]
};

export function seedDrafts(slug, key) {
  if (key !== "halloween") return [];
  const copy = HALLOWEEN_COPY[slug] || [0, 1, 2].map(() => ["Happy Halloween! 🎃", EN_TAGS]);
  return copy.map(([caption, hashtags], i) => ({
    id: `${key}-${i + 1}`, status: "draft", caption, hashtags,
    imageName: `${slug}_halloween_${i + 1}_4x5.jpg`, assetId: null, postIds: []
  }));
}

// The holiday's next date on or after today, in the brand's own time zone.
export function holidayDate(key, now, timeZone) {
  const h = HOLIDAYS[key];
  const today = ymdInTimeZone(now, timeZone);
  const year = Number(today.slice(0, 4));
  const pad = (n) => String(n).padStart(2, "0");
  const thisYear = `${year}-${pad(h.month)}-${pad(h.day)}`;
  return thisYear >= today ? thisYear : `${year + 1}-${pad(h.month)}-${pad(h.day)}`;
}

// Post times for one draft on the holiday: today they start 25 minutes from now, otherwise mid-morning,
// 100 minutes apart per draft, never on a :00/:15/:30/:45 minute, different networks 7 minutes apart.
export function holidayTimes(ymd, timeZone, now, draftIndex, destinations) {
  const today = ymdInTimeZone(now, timeZone);
  const dayStart = localDateTimeToUtc(ymd, "09:00", timeZone).getTime();
  const dayEnd = localDateTimeToUtc(ymd, "23:20", timeZone).getTime();
  const base = ymd === today ? Math.max(now.getTime() + 25 * 60000, dayStart) : dayStart;
  return destinations.map((dest, i) => {
    let t = base + draftIndex * 100 * 60000 + i * 7 * 60000;
    if (ymd === today && t > dayEnd) t = now.getTime() + 25 * 60000 + (draftIndex * 3 + i) * 7 * 60000; // out of day: send soon instead
    const d = new Date(Math.floor(t / 60000) * 60000);
    if (d.getUTCMinutes() % 15 === 0) d.setUTCMinutes(d.getUTCMinutes() + 4);
    return d;
  });
}

const assetCard = (a) => a && ({ id: a.id, filename: a.filename, kind: a.kind, sourcePath: a.sourcePath, title: a.title, durationMs: a.durationMs });
const ASSET_COLS = `"id","filename","kind",COALESCE("sourcePath","sourceUrl") AS "sourcePath","title","durationMs"`;
const READY = `"approvalStatus"='approved' AND "ingestStatus"='ready' AND "retiredAt" IS NULL`;

async function readHolidays(client, brand, key) {
  const row = (await client.query('SELECT "settings"->\'holidays\'->$2 AS h FROM "Brand" WHERE "id"=$1', [brand.id, key])).rows[0];
  const stored = row?.h?.drafts;
  return Array.isArray(stored) && stored.length ? stored : seedDrafts(brand.slug, key);
}
async function saveDrafts(client, brand, key, drafts) {
  await client.query(
    `UPDATE "Brand" SET "settings" = jsonb_set(jsonb_set(COALESCE("settings",'{}'::jsonb), '{holidays}', COALESCE("settings"->'holidays','{}'::jsonb), true), ARRAY['holidays',$2::text], $3::jsonb, true), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [brand.id, key, JSON.stringify({ drafts })]);
}
const known = (key) => (Object.prototype.hasOwnProperty.call(HOLIDAYS, key) ? HOLIDAYS[key] : null);
const bad = (error, code = 400) => ({ code, body: { ok: false, error } });

export async function holidayList(client, brand, body, now = new Date()) {
  const key = String(body.key || "halloween");
  const h = known(key);
  if (!h) return bad("Unknown holiday");
  const tz = brand.timezone || "America/New_York";
  const drafts = await readHolidays(client, brand, key);
  const names = drafts.map((d) => d.imageName).filter(Boolean);
  const byName = new Map((await client.query(`SELECT ${ASSET_COLS} FROM "Asset" WHERE "brandId"=$1 AND "filename" = ANY($2::text[]) AND ${READY}`, [brand.id, names])).rows.map((a) => [a.filename, a]));
  const ids = drafts.map((d) => d.assetId).filter((id) => UUID.test(String(id || "")));
  const byId = new Map((ids.length ? (await client.query(`SELECT ${ASSET_COLS} FROM "Asset" WHERE "brandId"=$1 AND "id" = ANY($2::uuid[])`, [brand.id, ids])).rows : []).map((a) => [a.id, a]));
  const choices = (await client.query(`SELECT ${ASSET_COLS} FROM "Asset" WHERE "brandId"=$1 AND "kind"='image' AND ${READY} AND "filename" ILIKE '%halloween%' ORDER BY "filename" LIMIT 40`, [brand.id])).rows;
  const postIds = drafts.flatMap((d) => (d.postIds || []).filter((id) => UUID.test(String(id))));
  const posts = postIds.length ? (await client.query(
    `SELECT sp."id", sp."status", sp."scheduledFor", sa."destination", sa."accountName" FROM "ScheduledPost" sp JOIN "SocialAccount" sa ON sa."id"=sp."socialAccountId" WHERE sp."brandId"=$1 AND sp."id" = ANY($2::uuid[]) ORDER BY sp."scheduledFor"`, [brand.id, postIds])).rows : [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const accounts = (await client.query(
    `SELECT "destination" FROM "SocialAccount" WHERE "brandId"=$1 AND "status"='active' AND "externalAccountId" IS NOT NULL AND "destination" = ANY($2)`, [brand.id, HOLIDAY_DESTINATIONS])).rows.map((r) => r.destination);
  return {
    code: 200, body: {
      ok: true, brand: brand.slug, holiday: key, name: h.name, date: holidayDate(key, now, tz), timeZone: tz,
      destinations: [...new Set(accounts)],
      drafts: drafts.map((d) => {
        const asset = (d.assetId && byId.get(d.assetId)) || byName.get(d.imageName) || null;
        return {
          id: d.id, status: d.status, caption: d.caption, hashtags: d.hashtags || [], imageName: d.imageName,
          asset: assetCard(asset), imageReady: Boolean(asset),
          posts: (d.postIds || []).map((id) => postById.get(id)).filter(Boolean).map((p) => ({ id: p.id, status: p.status, destination: p.destination, accountName: p.accountName, scheduledFor: new Date(p.scheduledFor).toISOString() }))
        };
      }),
      choices: choices.map(assetCard)
    }
  };
}

async function mutate(client, brand, body, fn) {
  const key = String(body.key || "halloween");
  if (!known(key)) return bad("Unknown holiday");
  const drafts = await readHolidays(client, brand, key);
  const draft = drafts.find((d) => d.id === String(body.draftId || ""));
  if (!draft) return bad("Draft not found", 404);
  if (draft.status === "approved") return bad("This draft is already approved; change it on the Calendar", 409);
  const err = await fn(draft);
  if (err) return err;
  await saveDrafts(client, brand, key, drafts);
  return { code: 200, body: { ok: true } };
}

export const holidayEdit = (client, brand, body) => mutate(client, brand, body, async (d) => {
  const caption = String(body.caption ?? "").trim();
  if (!caption || caption.length > 280) return bad("A caption needs 1-280 characters (Bluesky's limit is the tightest)");
  d.caption = caption;
  d.hashtags = (Array.isArray(body.hashtags) ? body.hashtags : []).map((t) => String(t).replace(/^#*/, "").replace(/\s+/g, "").trim()).filter(Boolean).slice(0, 5);
  return null;
});

export const holidaySkip = (client, brand, body) => mutate(client, brand, body, async (d) => { d.status = body.skipped === false ? "draft" : "skipped"; return null; });

export const holidaySwap = (client, brand, body) => mutate(client, brand, body, async (d) => {
  if (!UUID.test(String(body.assetId || ""))) return bad("assetId is required");
  const a = (await client.query(`SELECT "id" FROM "Asset" WHERE "id"=$1 AND "brandId"=$2 AND "kind"='image' AND ${READY}`, [body.assetId, brand.id])).rows[0];
  if (!a) return bad("That is not an approved, ready image of this brand", 404);
  d.assetId = a.id;
  return null;
});

export async function holidayApprove(client, brand, body, now = new Date()) {
  const key = String(body.key || "halloween");
  if (!known(key)) return bad("Unknown holiday");
  const tz = brand.timezone || "America/New_York";
  const drafts = await readHolidays(client, brand, key);
  const wanted = new Set((Array.isArray(body.draftIds) ? body.draftIds : []).map(String));
  const targets = drafts.filter((d) => wanted.has(d.id) && d.status === "draft");
  if (!targets.length) return bad("Nothing to approve: pick drafts that are not skipped or already approved", 409);
  const accounts = (await client.query(
    `SELECT "id","destination","publishingMode" FROM "SocialAccount" WHERE "brandId"=$1 AND "status"='active' AND "externalAccountId" IS NOT NULL AND "destination" = ANY($2) ORDER BY "destination"`, [brand.id, HOLIDAY_DESTINATIONS])).rows;
  if (!accounts.length) return bad("This brand has no connected network for photo posts yet", 409);
  const date = holidayDate(key, now, tz);
  const approved = [], waiting = [];
  for (const d of targets) {
    let asset = null;
    if (UUID.test(String(d.assetId || ""))) asset = (await client.query(`SELECT "id" FROM "Asset" WHERE "id"=$1 AND "brandId"=$2 AND ${READY}`, [d.assetId, brand.id])).rows[0];
    else asset = (await client.query(`SELECT "id" FROM "Asset" WHERE "brandId"=$1 AND "filename"=$2 AND ${READY} LIMIT 1`, [brand.id, d.imageName])).rows[0];
    if (!asset) { waiting.push(d.id); continue; }
    const times = holidayTimes(date, tz, now, drafts.filter((x) => x.status === "approved" || approved.includes(x.id)).length, accounts.map((a) => a.destination));
    const ids = [];
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i];
      const r = await client.query(
        `INSERT INTO "ScheduledPost" ("brandId","socialAccountId","assetId","placement","scheduledFor","status","selectionReason","scoreBreakdown","publishingMode","generatedCaption","generatedHashtags","updatedAt")
         VALUES ($1,$2,$3,'post',$4,'approved',$5,$6::jsonb,$7,$8,$9,CURRENT_TIMESTAMP) RETURNING "id"`,
        [brand.id, a.id, asset.id, times[i].toISOString(), `Holiday: ${HOLIDAYS[key].name}`,
         JSON.stringify({ holiday: key, draftId: d.id, manual: true }), a.publishingMode || "auto", d.caption, d.hashtags || []]);
      ids.push(r.rows[0].id);
    }
    d.status = "approved"; d.assetId = asset.id; d.postIds = ids; approved.push(d.id);
  }
  if (approved.length) await saveDrafts(client, brand, key, drafts);
  return { code: 200, body: { ok: true, approved: approved.length, posts: approved.length * accounts.length, waitingForImage: waiting, date } };
}
