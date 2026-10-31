/**
 * Google Business Profile planning (Dean, 2026-10-31).
 *
 * The normal planner (planner-v2) is built for video clips and songs and skips Google Business. This module adds
 * Update posts for the Review page's "Posts per day" number on the GMB box (CadenceRule placement "update"):
 *
 *   - one post a day at most, on the days that spread best across the week, at a time between 10:00 and 16:30 on the
 *     brand's own clock (the publisher gate is 9 AM-6 PM; GMB_ASSET_SPEC.md);
 *   - a pillar per post (A shows for hire, B custom song libraries, C label streaming + ads, F fan/release) chosen so
 *     business pillars stay over half of the last 30 days (the same rule gmb-lambda's mixAllows enforces at publish);
 *   - a real photo from the brand's image/4x3, image/3x2 or image/16x9 folders, 1200x800 or larger, 10 KB-5 MB, JPG or
 *     PNG. A filename like `stashbox_band_A_live-music-for-your-event_03_4x3.jpg` pins a photo to pillar A; a photo
 *     without a pillar letter fits any pillar. A photo is not reused until the others have been used;
 *   - a caption from the pillar's written variants (no URL, no phone number, no ALL CAPS, 1,350 characters at most);
 *   - exactly one button with its link (BOOK / LEARN_MORE / SHOP), set per pillar.
 *
 * Posts are saved `planned` (to review): they go out only after the owner approves them on Review, and the publisher
 * (services/gmb-lambda) re-checks every rule before anything reaches Google. Brands with no pillar wording yet are
 * skipped with a reason. Per-brand wording and buttons can be overridden in Brand.settings.gmb.pillars.<A|B|C|F>.
 */
import { ymdInTimeZone, addDaysToYmd, localDateTimeToUtc } from "./planner-v2.mjs";

export const GMB_PLANNER_VERSION = "gmb-planner.1";
const PHOTO_FOLDERS = ["%/image/4x3/%", "%/image/3x2/%", "%/image/16x9/%"];
const RATIOS = [4 / 3, 3 / 2, 16 / 9];
const RATIO_TOLERANCE = 0.02;
const MIN_W = 1200, MIN_H = 800, MIN_BYTES = 10 * 1024, MAX_BYTES = 5 * 1024 * 1024;
const WINDOW_FIRST_MINUTE = 10 * 60, WINDOW_LAST_MINUTE = 16 * 60 + 30;
const LEAD_MINUTES = 45;
const SUMMARY_MAX = 1350;
// A day already holding a post that is no longer a draft (or was paused/removed) is taken.
const TAKEN = ["approved", "paused", "removed", "queued", "publishing", "processing", "published"];
const COUNTED = ["planned", "approved", "queued", "publishing", "processing", "published"];

// Pillar wording and buttons. Only what the spec (GMB_ASSET_SPEC.md) and Dean's notes say: no invented clients, results or
// numbers. Dean approves each draft on Review before it can go out. Brands not listed here are skipped until they have pillars.
export const GMB_DEFAULTS = {
  stashbox: {
    languageCode: "en-US",
    pillars: {
      A: {
        weight: 0.45, cta: { actionType: "BOOK", url: "https://stashbox.com/booking" },
        captions: [
          "Book Stashbox for your next corporate event, resort night or private party. A full live band with our own sound and light, and sets tailored to your crowd. Now booking upcoming dates.",
          "Planning a company party, a resort night or a private celebration? Stashbox brings a full live band and builds the set around your guests. Tell us about your event and we will take it from there.",
          "Live music sets the mood for an event people remember. Stashbox plays corporate events, resorts, venues, festivals and private parties across South Florida. Request your date and we will tailor the night to your crowd."
        ]
      },
      B: {
        weight: 0.2, cta: { actionType: "LEARN_MORE", url: "https://stashbox.com" },
        captions: [
          "Your property should sound like you. We write and produce a custom original song library for resorts, restaurants and venues, so you own the music instead of renting generic playlists.",
          "Music is part of how a space feels. Stashbox creates original songs made for your resort, restaurant or venue, so your guests hear a sound that belongs to your brand and nobody else.",
          "Hotels, restaurants and retail spaces: stop playing the same playlist as everyone else. A custom song library from Stashbox gives your space its own signature sound."
        ]
      },
      C: {
        weight: 0.15, cta: { actionType: "LEARN_MORE", url: "https://stashbox.com" },
        captions: [
          "Labels and artists: own your audience. We build and run your own streaming video platform and advertising infrastructure, under your brand, with your data and your revenue.",
          "Artists and labels can run their own streaming video channel with advertising built in, under their own name. Stashbox builds the platform and keeps it running, so the audience and the data stay yours."
        ]
      },
      F: {
        weight: 0.2, cta: { actionType: "LEARN_MORE", url: "https://stashbox.com/radio" },
        captions: [
          "Stashbox Radio is on. Tune in for original Stashbox music and live band performances.",
          "Hear what the band sounds like when it plays live. Stashbox Radio has original music and live sessions from the Stashbox band.",
          "New to Stashbox? Start with Stashbox Radio, the home of our original songs and live band sessions."
        ]
      }
    }
  },
  elettro: {
    languageCode: "en-US",
    pillars: {
      C: {
        weight: 0.55, cta: { actionType: "LEARN_MORE", url: "https://elettro.com" },
        captions: [
          "Labels, artists and management: your audience should live on a platform you control. Elettro builds streaming video channels and advertising infrastructure under your own brand.",
          "Labels and artists: own your audience. We build and run your own streaming video platform and advertising infrastructure, under your brand, with your data and your revenue."
        ]
      },
      B: {
        weight: 0.45, cta: { actionType: "LEARN_MORE", url: "https://elettro.com" },
        captions: [
          "Resorts, restaurants and venues: your space deserves its own sound. We produce a custom original song library made for your brand.",
          "Your property should sound like you. A custom original song library gives your resort, restaurant or venue music that is yours alone."
        ]
      }
    }
  }
};

/** The pillar setup for a brand: the built-in wording, with Brand.settings.gmb.pillars.<letter> laid over it. Null when none. */
export function gmbConfigFor(brand) {
  const base = GMB_DEFAULTS[brand.slug];
  const own = brand.settings?.gmb;
  if (!base && !own?.pillars) return null;
  const pillars = {};
  for (const letter of ["A", "B", "C", "F"]) {
    const merged = { ...(base?.pillars?.[letter] || {}), ...(own?.pillars?.[letter] || {}) };
    if (merged.cta && Array.isArray(merged.captions) && merged.captions.length && Number(merged.weight) > 0) pillars[letter] = merged;
  }
  if (!Object.keys(pillars).length) return null;
  return { languageCode: own?.languageCode || base?.languageCode || "en-US", pillars };
}

// ---- checks that mirror services/gmb-lambda (kept in step by tests/gmb-planner.test.mjs) ----
const SCHEME_URL = /https?:\/\/\S+|\bwww\.\S+/i;
const BARE_DOMAIN = /\b[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|de|co|us|tv|fm|app|shop|radio|info|biz|me|ly|gg|xyz|online|site|store|link|page|dev|eu)\b/i;
export const captionHasUrl = (text) => {
  const plain = String(text).replace(/Reggae\.Land/g, "Reggae Land");
  return SCHEME_URL.test(plain) || BARE_DOMAIN.test(plain);
};
/** Why a caption cannot be used, or null. Same rules the publisher enforces, so a bad one never becomes a draft. */
export function captionProblem(text) {
  const s = String(text || "").trim();
  if (!s) return "empty";
  if (s.length > SUMMARY_MAX) return `over ${SUMMARY_MAX} characters`;
  if (captionHasUrl(s)) return "contains a URL or domain";
  if (/(?:\+?\d[\s().-]?){10,}/.test(s) || /\b\d{3}[-.\s]\d{4}\b/.test(s)) return "contains a phone number";
  if (/\b[A-Z]{4,}\b/.test(s)) return "has an ALL CAPS word";
  if ((s.match(/\p{Extended_Pictographic}/gu) || []).length > 2) return "has too many emojis";
  return null;
}
const buttonProblem = (cta) => {
  if (!cta || !["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"].includes(cta.actionType)) return "no valid button";
  if (cta.actionType === "CALL") return null;
  try { if (new URL(cta.url).protocol !== "https:") return "button link is not https"; } catch { return "button link is not a full URL"; }
  const product = /^\/products\//.test(new URL(cta.url).pathname);
  if (cta.actionType === "SHOP" && !product) return "SHOP must link to a /products/ page";
  if (product && cta.actionType !== "SHOP") return "a product link must use SHOP";
  return null;
};

// ---- pure helpers ----
const hashOf = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const mm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export function localMinutesOf(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/** `count` days spread as evenly as possible over the available day numbers. */
export function spreadDays(available, count) {
  const n = Math.min(count, available.length);
  if (n <= 0) return [];
  return [...new Set(Array.from({ length: n }, (_, k) => available[Math.min(available.length - 1, Math.floor(((k + 0.5) * available.length) / n))]))];
}

/** A stable minute for one brand and day inside the window, never on :00 :15 :30 :45 (planner convention). */
export function slotMinute(seed, from = WINDOW_FIRST_MINUTE, to = WINDOW_LAST_MINUTE) {
  if (from > to) return null;
  let m = from + (hashOf(seed) % (to - from + 1));
  if (m % 15 === 0) m = m + 7 <= to ? m + 7 : m - 7;
  return m >= from ? m : null;
}

/** Next pillar: the one furthest below its target share, with fan content held under half of the last 30 days. */
export function nextPillar(counts, weights, available) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sum = available.reduce((a, p) => a + weights[p], 0);
  const ranked = available.map((p) => ({ p, gap: weights[p] / sum - (counts[p] || 0) / (total || 1) })).sort((a, b) => b.gap - a.gap || weights[b.p] - weights[a.p]);
  for (const { p } of ranked) {
    if (p === "F" && ((counts.F || 0) + 1) / (total + 1) >= 0.5) continue;
    return p;
  }
  return null;
}

/**
 * Whether an asset row is a usable GMB post photo (type, size, dimensions, shape); the text says what is wrong, else null.
 * The Dropbox sync stores the file size but not the pixel size or MIME type, so a photo that was never measured is judged by
 * the folder it sits in (image/4x3, 3x2 or 16x9: the library's own size convention) and its extension. The publisher then
 * measures the real image before posting and blocks anything that is not really 4:3, 3:2 or 16:9 and 1200x800 or more.
 */
export function photoProblem(a) {
  const path = String(a.path || a.sourcePath || a.filename || "");
  const mime = String(a.mimeType || "").toLowerCase() || (/\.jpe?g$/i.test(path) ? "image/jpeg" : /\.png$/i.test(path) ? "image/png" : "");
  if (!["image/jpeg", "image/png"].includes(mime)) return "not a JPG or PNG";
  const bytes = Number(a.fileSizeBytes);
  if (!(bytes >= MIN_BYTES && bytes <= MAX_BYTES)) return "not 10 KB to 5 MB";
  const w = Number(a.width), h = Number(a.height);
  if (!(w > 0 && h > 0)) return /\/image\/(4x3|3x2|16x9)\//i.test(path) ? null : "size unknown";
  if (!(w >= MIN_W && h >= MIN_H)) return `${w}x${h} is under ${MIN_W}x${MIN_H}`;
  if (!RATIOS.some((r) => Math.abs(w / h - r) <= r * RATIO_TOLERANCE)) return `${w}x${h} is not 4:3, 3:2 or 16:9`;
  return null;
}
export const pillarOfFilename = (name) => /_([ABCF])_/.exec(String(name || ""))?.[1] || null;

/** The photo for a pillar: one that fits it, least recently used first, not already taken this run. */
export function pickPhoto(photos, pillar, lastUsed, takenNow) {
  const fits = photos.filter((p) => !takenNow.has(p.id) && (!p.pillar || p.pillar === pillar));
  fits.sort((a, b) => (lastUsed.get(a.id) || 0) - (lastUsed.get(b.id) || 0) || (b.pillar === pillar) - (a.pillar === pillar) || String(a.filename).localeCompare(String(b.filename)));
  return fits[0] || null;
}

/** The caption for a pillar: the variant used longest ago (or never). */
export function pickCaption(variants, recentCaptions) {
  const seen = new Map(recentCaptions.map((c, i) => [c, i]));    // later index = more recent
  return [...variants].sort((a, b) => (seen.has(a) ? seen.get(a) + 1 : 0) - (seen.has(b) ? seen.get(b) + 1 : 0))[0];
}

// ---- database ----
/**
 * Plans one brand's GMB Update posts for the week starting `weekStart` (a Monday, brand clock). Replaces this week's
 * still-`planned` GMB drafts. Returns { ok, planned, accounts: [...], message }.
 */
export async function planGmbWeek(client, brand, { weekStart, now = new Date() }) {
  const timeZone = brand.timezone || "America/New_York";
  const config = gmbConfigFor(brand);
  const accounts = (await client.query(
    `SELECT sa."id" AS "socialAccountId", sa."accountName", sa."publishingMode", cr."postsPerWeek"
     FROM "SocialAccount" sa JOIN "CadenceRule" cr ON cr."socialAccountId" = sa."id"
     WHERE sa."brandId" = $1 AND sa."destination" = 'gmb' AND sa."status" = 'active' AND sa."externalAccountId" IS NOT NULL
       AND cr."placement" = 'update' AND cr."active" = TRUE AND cr."postsPerWeek" > 0
     ORDER BY sa."accountName"`, [brand.id])).rows;
  if (!accounts.length) return { ok: true, planned: 0, accounts: [], message: "Google Business: no posts per day set" };
  if (!config) return { ok: true, planned: 0, accounts: [], message: "Google Business: this brand has no pillar wording yet" };

  const photoRows = (await client.query(
    `SELECT "id","filename","mimeType","fileSizeBytes","width","height", COALESCE("sourcePath","sourceUrl") AS "path"
     FROM "Asset"
     WHERE "brandId" = $1 AND "kind" = 'image' AND "approvalStatus" = 'approved' AND "ingestStatus" IN ('raw','needs_metadata','ready')
       AND "retiredAt" IS NULL AND COALESCE("sourcePath","sourceUrl") ILIKE ANY($2::text[])`, [brand.id, PHOTO_FOLDERS])).rows;
  const photos = []; const rejected = [];
  for (const a of photoRows) {
    const why = photoProblem(a);
    if (why) rejected.push({ filename: a.filename, why }); else photos.push({ id: a.id, filename: a.filename, pillar: pillarOfFilename(a.filename) });
  }

  const weekEnd = addDaysToYmd(weekStart, 7);
  const from = localDateTimeToUtc(weekStart, "00:00", timeZone), to = localDateTimeToUtc(weekEnd, "00:00", timeZone);
  const notBefore = new Date(now.getTime() + LEAD_MINUTES * 60000);
  const todayYmd = ymdInTimeZone(now, timeZone);
  const result = [];
  let plannedTotal = 0;

  await client.query("BEGIN");
  try {
    for (const account of accounts) {
      const out = { socialAccountId: account.socialAccountId, accountName: account.accountName, planned: 0, reason: null };
      // This week's drafts are replaced; everything else (approved, sent, paused, removed) stays and holds its day.
      await client.query(
        `DELETE FROM "ScheduledPost" WHERE "socialAccountId" = $1 AND "status" = 'planned' AND "placement" = 'update' AND "scheduledFor" >= $2 AND "scheduledFor" < $3`,
        [account.socialAccountId, from, to]);
      const history = (await client.query(
        `SELECT sp."assetId", sp."status", sp."scheduledFor", sp."generatedCaption", sp."scoreBreakdown"->'gmb'->>'pillar' AS "pillar"
         FROM "ScheduledPost" sp WHERE sp."socialAccountId" = $1 AND sp."placement" = 'update' AND sp."scheduledFor" >= $2::timestamp - INTERVAL '90 days'
         ORDER BY sp."scheduledFor"`, [account.socialAccountId, from])).rows;
      const lastUsed = new Map(); const recentCaptions = []; const counts = {};
      const takenDays = new Set();
      for (const h of history) {
        const at = new Date(h.scheduledFor).getTime();
        if (h.assetId) lastUsed.set(h.assetId, Math.max(lastUsed.get(h.assetId) || 0, at));
        if (h.generatedCaption) recentCaptions.push(h.generatedCaption);
        const inWeek = at >= from.getTime() && at < to.getTime();
        if (inWeek && TAKEN.includes(h.status)) takenDays.add(ymdInTimeZone(new Date(h.scheduledFor), timeZone));
        // the 30 days before the end of the week count toward the business mix
        if (COUNTED.includes(h.status) && h.pillar && at >= to.getTime() - 30 * 864e5 && at < to.getTime()) counts[h.pillar] = (counts[h.pillar] || 0) + 1;
      }

      const available = [];
      for (let d = 0; d < 7; d++) {
        const ymd = addDaysToYmd(weekStart, d);
        if (ymd < todayYmd || takenDays.has(ymd)) continue;
        if (ymd === todayYmd && localMinutesOf(notBefore, timeZone) + 1 > WINDOW_LAST_MINUTE) continue;   // too late today: another day takes the post
        available.push(d);
      }
      const days = spreadDays(available, Number(account.postsPerWeek));
      const pillars = Object.keys(config.pillars);
      const weights = Object.fromEntries(pillars.map((p) => [p, Number(config.pillars[p].weight)]));
      const takenNow = new Set();
      const notes = [];
      for (const d of days) {
        const ymd = addDaysToYmd(weekStart, d);
        // Today's slot starts after the lead time; later days use the whole window.
        let first = WINDOW_FIRST_MINUTE;
        if (ymd === todayYmd) first = Math.max(first, localMinutesOf(notBefore, timeZone) + 1);
        const minute = slotMinute(`${brand.slug}|${ymd}`, first, WINDOW_LAST_MINUTE);
        if (minute === null) { notes.push(`${ymd}: too late in the day`); continue; }
        const eligible = pillars.filter((p) => pickPhoto(photos, p, lastUsed, takenNow));
        const pillar = nextPillar(counts, weights, eligible);
        if (!pillar) { notes.push(`${ymd}: no photo fits a pillar`); continue; }
        const setup = config.pillars[pillar];
        const photo = pickPhoto(photos, pillar, lastUsed, takenNow);
        const usable = setup.captions.filter((c) => !captionProblem(c));
        const bad = buttonProblem(setup.cta);
        if (!usable.length || bad) { notes.push(`${ymd}: pillar ${pillar} setup invalid (${bad || "no usable caption"})`); continue; }
        const caption = pickCaption(usable, recentCaptions);
        const when = localDateTimeToUtc(ymd, mm(minute), timeZone);
        await client.query(
          `INSERT INTO "ScheduledPost" ("brandId","socialAccountId","assetId","placement","scheduledFor","status","selectionReason","scoreBreakdown","publishingMode","generatedCaption","generatedHashtags","updatedAt")
           VALUES ($1,$2,$3,'update',$4,'planned',$5,$6::jsonb,$7,$8,$9,CURRENT_TIMESTAMP)`,
          [brand.id, account.socialAccountId, photo.id, when.toISOString(),
           `Google Business pillar ${pillar}: photo ${photo.filename}`,
           JSON.stringify({ plannerVersion: GMB_PLANNER_VERSION, weekStart, gmb: { pillar, topicType: "STANDARD", languageCode: config.languageCode, cta: { actionType: setup.cta.actionType, ...(setup.cta.url ? { url: setup.cta.url } : {}) } }, copy: { source: "gmb-pillar-wording", status: "ready" } }),
           account.publishingMode || "approval", caption, []]);
        takenNow.add(photo.id); lastUsed.set(photo.id, when.getTime()); recentCaptions.push(caption);
        counts[pillar] = (counts[pillar] || 0) + 1;
        out.planned += 1;
      }
      if (!out.planned) out.reason = !photos.length
        ? `no usable photos in the image/4x3, 3x2 or 16x9 folders${rejected.length ? ` (${rejected.length} rejected, e.g. ${rejected[0].filename}: ${rejected[0].why})` : ""}`
        : notes[0] || (days.length ? "nothing could be planned" : "no free days left this week");
      else if (notes.length) out.reason = notes.join("; ");
      plannedTotal += out.planned;
      result.push(out);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const first = result.find((r) => r.reason);
  return { ok: true, planned: plannedTotal, accounts: result, rejectedPhotos: rejected.length,
    message: plannedTotal ? `Google Business: ${plannedTotal} draft${plannedTotal === 1 ? "" : "s"} to review${first ? ` (${first.reason})` : ""}` : `Google Business: nothing planned, ${first?.reason || "no free days"}` };
}
