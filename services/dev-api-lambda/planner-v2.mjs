// Planner V2: config-driven week planning. Code enforces the rules (pool, cooldowns,
// cadence, sector mix); an optional curator may only choose among candidates that
// already passed them, and every choice is re-validated here.
import { createHash } from "node:crypto";
import { placementRule } from "./publishing-formats.mjs";

export const PLANNER_VERSION = "planner-v2.0";
export const DURATION_BUCKETS = ["under-15s", "15-30s", "30-60s", "1-3min", "3min-plus"];
const DAY_MS = 86400000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DEFAULT_PLANNER_SETTINGS = {
  version: 1,
  pool: { aspectRatios: [], kinds: [], excludeTagsAny: [] },
  // Placements every brand gets unless its own settings define them. Pinterest pins photos
  // (2:3 is Pinterest's ideal, 4:5 and 1:1 also work) and 9:16 clips as video Pins.
  placements: {
    "pinterest:pin": { kinds: ["image"], aspectRatios: ["2x3", "4x5", "1x1"] },
    "pinterest:video": { kinds: ["video"], aspectRatios: ["9x16"], maxDurationBucket: "1-3min", preferredDurationBuckets: ["15-30s", "30-60s"] }
  },
  sectors: [],
  minPoolForSector: 3,
  exploration: { default: 0 },
  cooldowns: { assetDays: 30, songDays: 1, productDays: 15 },
  newBatchBoostDays: 14,
  syntheticTagsAny: [],
  readyTagsAny: [],
  candidatesPerSlot: 5
};

export function resolvePlannerSettings(brandSettings) {
  const raw = (brandSettings && typeof brandSettings === "object" && brandSettings.planner) || {};
  return {
    ...DEFAULT_PLANNER_SETTINGS,
    ...raw,
    pool: { ...DEFAULT_PLANNER_SETTINGS.pool, ...(raw.pool || {}) },
    placements: { ...DEFAULT_PLANNER_SETTINGS.placements, ...(raw.placements || {}) },
    exploration: { ...DEFAULT_PLANNER_SETTINGS.exploration, ...(raw.exploration || {}) },
    cooldowns: { ...DEFAULT_PLANNER_SETTINGS.cooldowns, ...(raw.cooldowns || {}) }
  };
}

// ---------- dates (same conventions as index.mjs) ----------

export function addDaysToYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

export function weekdayOfYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

export function ymdInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export function localDateTimeToUtc(ymd, hhmm, timeZone) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hour, minute] = String(hhmm || "12:00").split(":").map(Number);
  const desired = Date.UTC(y, m - 1, d, hour || 0, minute || 0, 0);
  let utcMillis = desired;
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date(utcMillis));
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const rendered = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour === "24" ? "0" : v.hour), Number(v.minute), 0);
    utcMillis += desired - rendered;
  }
  return new Date(utcMillis);
}

/** Monday on or after `fromYmd` (a full Mon–Sun week for approval). */
export function nextWeekStart(fromYmd) {
  const offset = (8 - WEEKDAYS.indexOf(weekdayOfYmd(fromYmd))) % 7;
  return addDaysToYmd(fromYmd, offset === 0 ? 7 : offset);
}

function minutesOf(hhmm, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function hhmmOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---------- asset facts ----------

const tagsOf = (asset) => (Array.isArray(asset?.tags) ? asset.tags : []).map((t) => String(t).toLowerCase());
const hasAny = (tags, wanted) => Array.isArray(wanted) && wanted.some((t) => tags.includes(String(t).toLowerCase()));

export function songKeyOf(asset) {
  const tag = tagsOf(asset).find((t) => t.startsWith("song:"));
  return tag ? tag.slice(5) : null;
}

export function durationBucketOf(asset) {
  if (Number.isFinite(asset?.durationMs) && asset.durationMs > 0) {
    const s = asset.durationMs / 1000;
    return s < 15 ? "under-15s" : s < 30 ? "15-30s" : s < 60 ? "30-60s" : s < 180 ? "1-3min" : "3min-plus";
  }
  const tags = tagsOf(asset);
  return DURATION_BUCKETS.find((b) => tags.includes(b)) || null;
}

export function sectorsOf(asset, settings) {
  const tags = tagsOf(asset);
  const group = String(asset?.contentGroup || "").toLowerCase();
  return settings.sectors
    .filter((s) => hasAny(tags, s.match?.tagsAny) ||
      (Array.isArray(s.match?.tagSetsAny) && s.match.tagSetsAny.some((set) => set.length && set.every((t) => tags.includes(String(t).toLowerCase())))) ||
      (Array.isArray(s.match?.contentGroupsAny) && s.match.contentGroupsAny.some((g) => String(g).toLowerCase() === group)))
    .map((s) => s.slug);
}

/**
 * Sector requirements that make a post honest: a radio post needs the song's own
 * radio page, a streaming post needs a streaming link on the song record.
 */
// A released song without its own streaming link can still point to the artist profile.
const REQUIREMENTS = {
  radioLink: (facts) => Boolean(facts?.radioUrl),
  streamingLink: (facts, asset, settings) => Boolean(facts?.spotifyUrl || facts?.appleMusicUrl || facts?.youtubeMusicUrl) ||
    (Boolean(settings?.links?.streaming?.spotify) && hasAny(tagsOf(asset), settings?.releasedTagsAny))
};

export function meetsSectorRequirements(asset, sector, songFacts, settings) {
  const facts = songFacts?.[songKeyOf(asset)];
  return (sector.requires || []).every((r) => REQUIREMENTS[r] ? REQUIREMENTS[r](facts, asset, settings) : false);
}

/** Which value of a balance group (e.g. which show) an asset belongs to, or null. */
export function balanceValueOf(asset, group) {
  const tags = tagsOf(asset);
  const hit = Object.entries(group.values || {}).find(([, m]) => hasAny(tags, m.tagsAny) ||
    (Array.isArray(m.tagSetsAny) && m.tagSetsAny.some((set) => set.length && set.every((t) => tags.includes(String(t).toLowerCase())))));
  return hit ? hit[0] : null;
}

// A clip's spoken/sung language: a tag naming one ("german", "lang:de", "language:spanish") wins;
// otherwise the brand's language, which is English unless listed here or set as Brand.settings.language.
// Bare two-letter tags don't count; they are too easy to hit by accident.
const BRAND_LANGUAGES = { solarmeister: "de", "neckermann-strom": "de" };

export function brandLanguage(slug, settings) {
  const set = settings && typeof settings === "object" ? settings.language : null;
  return typeof set === "string" && /^[a-z]{2}$/.test(set) ? set : BRAND_LANGUAGES[slug] || "en";
}

const LANGUAGES = {
  en: ["english"], de: ["german", "deutsch"], es: ["spanish", "espanol", "español"], fr: ["french", "francais", "français"],
  it: ["italian", "italiano"], pt: ["portuguese", "portugues", "português"], nl: ["dutch"], ja: ["japanese"], ko: ["korean"],
  zh: ["chinese", "mandarin"], hi: ["hindi"], ar: ["arabic"], ru: ["russian"], he: ["hebrew"]
};
const LANGUAGE_BY_NAME = new Map(Object.entries(LANGUAGES).flatMap(([code, names]) => names.map((n) => [n, code])));

export function languageOf(asset, fallback = "en") {
  for (const tag of tagsOf(asset)) {
    const prefixed = tag.match(/^(?:lang|language)[:\-_](.+)$/)?.[1];
    const code = prefixed ? (LANGUAGES[prefixed] ? prefixed : LANGUAGE_BY_NAME.get(prefixed)) : LANGUAGE_BY_NAME.get(tag);
    if (code) return code;
  }
  return fallback;
}

export function isSynthetic(asset, settings) {
  return hasAny(tagsOf(asset), settings.syntheticTagsAny);
}

export function eligibleOn(asset, ymd) {
  if (asset.eligibilityType === "one_time") {
    const from = asset.eligibleFrom ? String(asset.eligibleFrom).slice(0, 10) : null;
    const until = asset.eligibleUntil ? String(asset.eligibleUntil).slice(0, 10) : null;
    if ((from && ymd < from) || (until && ymd > until)) return false;
  }
  if (asset.eligibilityType === "annual") {
    const mmdd = Number(ymd.slice(5, 7) + ymd.slice(8, 10));
    const from = Number(asset.annualFromMmdd || 0);
    const until = Number(asset.annualUntilMmdd || 0);
    if (from && until && (from <= until ? (mmdd < from || mmdd > until) : !(mmdd >= from || mmdd <= until))) return false;
  }
  return true;
}

/** Hard pool rules for one account. Returns null when allowed, otherwise the reason. */
export function poolRejection(asset, account, settings) {
  const tags = tagsOf(asset);
  const { pool } = settings;
  const dest = String(account.destination).toLowerCase();
  const rule = placementRule(settings, dest, String(account.placement).toLowerCase());
  // A placement may override the brand pool, e.g. youtube:video takes 16x9 long-form while Shorts stay 9x16.
  const kinds = rule.kinds || pool.kinds;
  const aspectRatios = rule.aspectRatios || pool.aspectRatios;
  if (kinds.length && !kinds.includes(asset.kind)) return "kind";
  if (aspectRatios.length && !aspectRatios.includes(asset.aspectRatioLabel)) return "aspect";
  if (hasAny(tags, pool.excludeTagsAny)) return "excluded-tag";
  const allowed = Array.isArray(asset.allowedDestinations) ? asset.allowedDestinations : [];
  const excluded = Array.isArray(asset.excludedDestinations) ? asset.excludedDestinations : [];
  if (excluded.includes(dest) || (allowed.length && !allowed.includes(dest))) return "destination";
  const bucket = durationBucketOf(asset);
  if (rule.maxDurationBucket && bucket &&
      DURATION_BUCKETS.indexOf(bucket) > DURATION_BUCKETS.indexOf(rule.maxDurationBucket)) return "duration";
  if (rule.minDurationBucket && (!bucket ||
      DURATION_BUCKETS.indexOf(bucket) < DURATION_BUCKETS.indexOf(rule.minDurationBucket))) return "duration";
  return null;
}

// ---------- slots ----------

/** Spread postsPerWeek over the allowed days, then evenly across each day's time window. */
export function buildSlots(account, weekStart, timeZone) {
  const days = [];
  const preferred = (account.preferredDays || []).map((d) => String(d).slice(0, 3).toLowerCase());
  for (let i = 0; i < 7; i += 1) {
    const ymd = addDaysToYmd(weekStart, i);
    if (!preferred.length || preferred.includes(weekdayOfYmd(ymd).toLowerCase())) days.push(ymd);
  }
  const total = Math.max(0, Math.round(Number(account.postsPerWeek) || 0));
  if (!days.length || !total) return [];
  const start = minutesOf(account.preferredStartTime, 12 * 60);
  const end = Math.max(start, minutesOf(account.preferredEndTime, start));
  const slots = [];
  days.forEach((ymd, dayIndex) => {
    const count = Math.floor((total * (dayIndex + 1)) / days.length) - Math.floor((total * dayIndex) / days.length);
    for (let k = 0; k < count; k += 1) {
      // Even spacing, rounded to the quarter hour so post times read like a schedule.
      const minute = count === 1 ? start : Math.round((start + (k * (end - start)) / (count - 1)) / 15) * 15;
      const local = hhmmOf(minute);
      slots.push({
        slotId: `${account.socialAccountId}:${ymd}:${local}`,
        socialAccountId: account.socialAccountId,
        destination: String(account.destination).toLowerCase(),
        placement: account.placement,
        accountName: account.accountName,
        publishingMode: account.publishingMode,
        ymd,
        localTime: local,
        scheduledFor: localDateTimeToUtc(ymd, local, account.timezone || timeZone).toISOString()
      });
    }
  });
  return slots;
}

/**
 * The slots to plan for one account: the week's grid minus the past, except that today is topped up to its
 * daily count. `doneToday` is how many posts of this format already went out today (ledger); today keeps
 * (day's count - done) slots, spread across what is left of the posting window. A replan late in the day
 * therefore neither repeats the posts that went out nor drops the rest of the day's quota.
 */
export function slotsToPlan(account, weekStart, timeZone, now, doneToday = 0) {
  const all = buildSlots(account, weekStart, timeZone);
  const future = all.filter((s) => new Date(s.scheduledFor) > now);
  const tz = account.timezone || timeZone;
  const today = ymdInTimeZone(now, tz);
  const todays = all.filter((s) => s.ymd === today);
  if (!todays.length) return future;
  const need = Math.max(0, todays.length - Math.max(0, Number(doneToday) || 0));
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const nowMin = (Number(parts.hour === "24" ? "0" : parts.hour) * 60) + Number(parts.minute);
  const windowStart = minutesOf(account.preferredStartTime, 12 * 60);
  const windowEnd = Math.max(windowStart, minutesOf(account.preferredEndTime, windowStart));
  const first = Math.max(windowStart, (Math.floor(nowMin / 15) + 1) * 15);
  const room = windowEnd >= first ? Math.floor((windowEnd - first) / 15) + 1 : 0;
  const count = Math.min(need, room);
  const rest = future.filter((s) => s.ymd !== today);
  const topped = [];
  for (let k = 0; k < count; k += 1) {
    const minute = count === 1 ? first : Math.round((first + (k * (windowEnd - first)) / (count - 1)) / 15) * 15;
    const local = hhmmOf(minute);
    topped.push({ ...todays[0], slotId: `${account.socialAccountId}:${today}:${local}`, localTime: local,
      scheduledFor: localDateTimeToUtc(today, local, tz).toISOString() });
  }
  return [...topped, ...rest];
}

/** Deterministic smooth weighted round-robin: sector order that tracks the shares. */
export function sectorSequence(count, shares) {
  const entries = shares.filter((s) => s.share > 0);
  const totalShare = entries.reduce((sum, s) => sum + s.share, 0);
  if (!entries.length || !count) return Array(count).fill(null);
  const current = Object.fromEntries(entries.map((s) => [s.slug, 0]));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    for (const s of entries) current[s.slug] += s.share / totalShare;
    const best = entries.reduce((a, b) => (current[b.slug] > current[a.slug] + 1e-9 ? b : a));
    current[best.slug] -= 1;
    out.push(best.slug);
  }
  return out;
}

export function explorationFlags(count, rate) {
  return Array.from({ length: count }, (_, i) => Math.floor((i + 1) * rate) > Math.floor(i * rate));
}

// ---------- selection ----------

function priorityScore(priority) {
  return priority === "hero" ? 40 : priority === "high" ? 25 : priority === "low" ? 0 : 10;
}

function jitter(...parts) {
  return parseInt(createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 6), 16) / 0xffffff * 3;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Plan one week. Pure: no I/O. `uses` are past or already-scheduled posts:
 * { socialAccountId, assetId, songKey, shopifyProductId, contentGroup, at (ISO) }.
 * `preferences` maps slotId -> assetId (from the curator); honored only if still valid.
 */
export function planWeek({ assets, accounts, settings, weekStart, timeZone, uses = [], now = new Date(), preferences = {}, songFacts = {}, doneToday = {} }) {
  const cd = settings.cooldowns;
  const results = [];
  const gaps = [];
  const sectorsWaiting = new Set();
  const planned = [];
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const brandUsedAssets = new Set(uses.map((u) => u.assetId));

  // Per-account pool and the sectors that have enough content to take part this week.
  const perAccount = accounts.map((account) => {
    const pool = assets.filter((a) => !poolRejection(a, account, settings));
    const bySector = Object.fromEntries(settings.sectors.map((s) => [s.slug,
      pool.filter((a) => sectorsOf(a, settings).includes(s.slug) && meetsSectorRequirements(a, s, songFacts, settings))]));
    const active = settings.sectors.filter((s) => bySector[s.slug].length >= (settings.minPoolForSector || 1));
    settings.sectors.filter((s) => !active.includes(s)).forEach((s) => sectorsWaiting.add(s.slug));
    const slots = slotsToPlan(account, weekStart, timeZone, now, doneToday[`${account.socialAccountId}:${account.placement}`] || 0);
    const sequence = sectorSequence(slots.length, active.map((s) => ({ slug: s.slug, share: s.share })));
    const rate = settings.exploration[String(account.destination).toLowerCase()] ?? settings.exploration.default ?? 0;
    const explore = explorationFlags(slots.length, rate);
    slots.forEach((slot, i) => { slot.sector = sequence[i]; slot.exploration = explore[i]; });
    return { account, pool, bySector, active, slots };
  });

  const allSlots = perAccount.flatMap((p) => p.slots.map((slot) => ({ slot, ctx: p })))
    .sort((a, b) => a.slot.scheduledFor.localeCompare(b.slot.scheduledFor) || a.slot.slotId.localeCompare(b.slot.slotId));

  for (const { slot, ctx } of allSlots) {
    const at = new Date(slot.scheduledFor);
    const history = [...uses, ...planned].filter((u) => u.socialAccountId === slot.socialAccountId);
    const weekStartMs = localDateTimeToUtc(weekStart, "00:00", timeZone).getTime();
    const thisWeek = history.filter((u) => new Date(u.at).getTime() >= weekStartMs);

    const blockedBy = (asset) => {
      const song = songKeyOf(asset);
      for (const u of history) {
        const gapDays = Math.abs(at.getTime() - new Date(u.at).getTime()) / DAY_MS;
        if (u.assetId === asset.id && gapDays < cd.assetDays) return "asset-cooldown";
        if (song && u.songKey === song && gapDays < cd.songDays) return "song-cooldown";
        if (asset.shopifyProductId && u.shopifyProductId === asset.shopifyProductId && gapDays < cd.productDays) return "product-cooldown";
      }
      if (!eligibleOn(asset, slot.ymd)) return "eligibility";
      return null;
    };

    const score = (asset) => {
      const song = songKeyOf(asset);
      const lastUse = history.filter((u) => u.assetId === asset.id).map((u) => new Date(u.at).getTime()).sort((a, b) => b - a)[0];
      const freshness = lastUse ? Math.min(40, Math.max(0, (at.getTime() - lastUse) / DAY_MS - cd.assetDays)) : 40;
      const ageDays = asset.createdAt ? (at.getTime() - new Date(asset.createdAt).getTime()) / DAY_MS : Infinity;
      const newBatch = ageDays < settings.newBatchBoostDays ? 15 * (1 - Math.max(0, ageDays) / settings.newBatchBoostDays) : 0;
      const songRepeats = song ? thisWeek.filter((u) => u.songKey === song).length : 0;
      const groupRepeats = asset.contentGroup ? thisWeek.filter((u) => u.contentGroup === asset.contentGroup).length : 0;
      const rule = placementRule(settings, slot.destination, String(slot.placement).toLowerCase());
      // Keep groups like the two shows in balance within a sector: favor the value used least this week.
      let balance = 0;
      for (const group of settings.balance || []) {
        if (group.sectors && !group.sectors.includes(slot.sector)) continue;
        const mine = balanceValueOf(asset, group);
        if (!mine) continue;
        const counts = Object.fromEntries(Object.keys(group.values).map((v) => [v, 0]));
        for (const u of thisWeek) {
          const used = assetById.get(u.assetId);
          const v = used ? balanceValueOf(used, group) : null;
          if (v) counts[v] += 1;
        }
        const least = Math.min(...Object.values(counts));
        balance += counts[mine] === least ? (group.weight ?? 12) : -4 * (counts[mine] - least);
      }
      const breakdown = {
        balance,
        freshness: round2(freshness),
        newBatch: round2(newBatch),
        priority: priorityScore(asset.priority),
        songVariety: -10 * songRepeats,
        groupVariety: -4 * groupRepeats,
        ready: hasAny(tagsOf(asset), settings.readyTagsAny) ? 8 : 0,
        durationFit: (rule.preferredDurationBuckets || []).includes(durationBucketOf(asset)) ? 6 : 0,
        exploration: slot.exploration
          ? (song && !history.some((u) => u.songKey === song) ? 25 : 0) + (brandUsedAssets.has(asset.id) ? 0 : 10)
          : 0,
        tiebreak: round2(jitter(asset.id, slot.slotId))
      };
      return { total: round2(Object.values(breakdown).reduce((s, v) => s + v, 0)), breakdown };
    };

    const rank = (sector) => (ctx.bySector[sector] || [])
      .filter((a) => !blockedBy(a))
      .map((a) => ({ asset: a, ...score(a) }))
      .sort((x, y) => y.total - x.total);

    let sector = slot.sector;
    let ranked = sector ? rank(sector) : [];
    let fallbackFrom = null;
    if (!ranked.length) {
      for (const alt of [...ctx.active].sort((a, b) => a.priority - b.priority)) {
        if (alt.slug === sector) continue;
        ranked = rank(alt.slug);
        if (ranked.length) { fallbackFrom = sector; sector = alt.slug; break; }
      }
    }

    const candidates = ranked.slice(0, settings.candidatesPerSlot || 5);
    const pref = preferences[slot.slotId] || null;
    const preferred = pref?.assetId ? ranked.find((c) => c.asset.id === pref.assetId) : null;
    const declined = Boolean(pref?.declined) && candidates.length > 0;
    const winner = declined ? null : preferred || candidates[0];
    const curatorNote = pref?.reason ? String(pref.reason).slice(0, 400) : null;
    const candidateView = candidates.map((c) => ({
      assetId: c.asset.id, filename: c.asset.filename, songKey: songKeyOf(c.asset), contentGroup: c.asset.contentGroup || null,
      title: c.asset.title || null, notes: c.asset.creativeNotes ? String(c.asset.creativeNotes).slice(0, 300) : null,
      tags: tagsOf(c.asset).slice(0, 25), synthetic: isSynthetic(c.asset, settings), score: c.total, breakdown: c.breakdown
    }));

    if (!winner) {
      const reason = declined
        ? `Curator declined every candidate: ${pref.gap || curatorNote || "no reason given"}`
        : `No ${slot.sector || "eligible"} clip passed pool and cooldown rules`;
      gaps.push({ slotId: slot.slotId, destination: slot.destination, ymd: slot.ymd, sector: slot.sector, reason });
      results.push({ ...slot, status: "gap", gap: reason, selectedBy: declined ? "curator" : "rules", candidates: candidateView });
      continue;
    }

    const asset = winner.asset;
    const song = songKeyOf(asset);
    planned.push({ socialAccountId: slot.socialAccountId, assetId: asset.id, songKey: song,
      shopifyProductId: asset.shopifyProductId || null, contentGroup: asset.contentGroup || null, at: slot.scheduledFor });
    if (fallbackFrom) gaps.push({ slotId: slot.slotId, destination: slot.destination, ymd: slot.ymd, sector: fallbackFrom,
      reason: `No ${fallbackFrom} clip available; filled with ${sector}` });

    const curated = preferred && preferred !== candidates[0];
    const overridden = Boolean(pref?.assetId) && !preferred;
    results.push({
      ...slot,
      sector,
      sectorFallbackFrom: fallbackFrom,
      status: "planned",
      assetId: asset.id,
      filename: asset.filename,
      songKey: song,
      contentGroup: asset.contentGroup || null,
      synthetic: isSynthetic(asset, settings),
      selectedBy: preferred ? "curator" : "rules",
      curatorReason: preferred ? curatorNote : null,
      curatorOverridden: overridden,
      score: winner.total,
      breakdown: winner.breakdown,
      reason: [
        `${sector}${slot.exploration ? " exploration" : ""} slot`,
        song ? `song ${song}` : "no song tag",
        asset.contentGroup ? `from ${asset.contentGroup}` : null,
        curated ? `curator pick over rules #1 (${candidates[0].asset.filename})` : `rules score ${winner.total}`,
        overridden ? "curator pick broke a rule; rules #1 used" : null,
        fallbackFrom ? `(${fallbackFrom} had no eligible clip)` : null
      ].filter(Boolean).join("; "),
      candidates: candidateView
    });
  }

  const summary = perAccount.map(({ account, pool, active }) => {
    const mine = results.filter((r) => r.socialAccountId === account.socialAccountId);
    const count = (key) => mine.reduce((m, r) => { if (r[key]) m[r[key]] = (m[r[key]] || 0) + 1; return m; }, {});
    return {
      socialAccountId: account.socialAccountId, destination: account.destination, placement: account.placement,
      poolSize: pool.length, activeSectors: active.map((s) => s.slug), slots: mine.length,
      planned: mine.filter((r) => r.status === "planned").length, gaps: mine.filter((r) => r.status === "gap").length,
      bySector: count("sector"), distinctSongs: new Set(mine.map((r) => r.songKey).filter(Boolean)).size,
      exploration: mine.filter((r) => r.exploration).length, synthetic: mine.filter((r) => r.synthetic).length
    };
  });

  return {
    plannerVersion: PLANNER_VERSION,
    weekStart,
    weekEnd: addDaysToYmd(weekStart, 6),
    slots: results,
    gaps,
    sectorsWaitingForContent: [...sectorsWaiting].filter((slug) => !perAccount.some((p) => p.active.some((s) => s.slug === slug))),
    summary,
    assetsConsidered: assetById.size
  };
}
