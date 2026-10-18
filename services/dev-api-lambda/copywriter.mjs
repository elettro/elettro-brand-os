// Captions for planned posts (task write_copy). Facts come only from records:
// asset tags, the radio song catalog and the brand's link settings. The AI writes
// when a model is configured; a deterministic template writes otherwise or when
// the AI output fails validation. Code checks links, lengths and banned phrases.
import { createHash } from "node:crypto";
import { buildGuidance } from "./intelligence.mjs";
import { songKeyOf } from "./planner-v2.mjs";

const LIMITS = {
  youtube: { title: 100, description: 5000, hashtags: 5 },
  instagram: { caption: 2200, hashtags: 5 },
  tiktok: { caption: 2200, hashtags: 5 },
  facebook: { caption: 5000, hashtags: 2 },
  x: { caption: 280, hashtags: 2 }
};
const CLICKABLE = new Set(["youtube", "facebook", "x"]);
const BANNED = [/\belevate\b/i, /\bunleash/i, /\bunlock/i, /\bdive into\b/i, /game[- ]changer/i, /experience the magic/i, /it'?s not just .+, it'?s/i];
const SHOWS = { "stashbox-does-dylan": "Stashbox Does Dylan", "stashbox-does-sublime": "Stashbox Does Sublime & Reggae" };
const ROLE_WORDS = { vocals: "vocals", guitar: "guitar", bass: "bass", drums: "drums", keyboards: "keys", keys: "keys" };

const titleCase = (slug) => String(slug).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const pick = (seed, list) => list[parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % list.length];

/** Everything a caption may state about this post, from records only. */
export function postFacts(asset, slot, songFacts = {}, links = {}, { promotional = true } = {}) {
  const tags = (asset.tags || []).map((t) => String(t).toLowerCase());
  const valueOf = (prefix) => tags.find((t) => t.startsWith(prefix + ":"))?.slice(prefix.length + 1) || null;
  const slug = songKeyOf(asset);
  const song = slug ? songFacts[slug] : null;
  // Reggae covers belong to the Sublime & Reggae show set even without the show tag.
  const showTag = Object.keys(SHOWS).find((t) => tags.includes(t)) ||
    (slot.sector === "live-shows" && tags.includes("reggae") && tags.includes("licensed-cover") ? "stashbox-does-sublime" : null);
  const people = {};
  for (const t of tags) {
    const m = /^([a-z]+-[a-z-]+):(vocals|guitar|bass|drums|keyboards|keys)$/.exec(t);
    if (m) (people[m[1]] = people[m[1]] || []).push(ROLE_WORDS[m[2]]);
  }
  const ymd = valueOf("date");
  const synthetic = Boolean(slot.synthetic);
  const sectorLinks = {
    "live-shows": links.booking?.page ? [links.booking.page] : [],
    radio: song?.radioUrl ? [song.radioUrl] : [],
    // Spotify first (song, then artist profile), then the other platforms.
    streaming: [song?.spotifyUrl, links.streaming?.spotify, song?.appleMusicUrl, song?.youtubeMusicUrl,
      links.streaming?.appleMusic, links.streaming?.amazonMusic, links.streaming?.tidal].filter(Boolean)
  }[slot.sector] || [];
  const artistLinks = Object.values(links.streaming || {}).filter(Boolean);
  return {
    sector: slot.sector,
    destination: slot.destination,
    placement: slot.placement,
    song: slug ? song?.title || asset.topic || titleCase(slug) : null,
    show: showTag ? SHOWS[showTag] : null,
    isCover: tags.some((t) => ["cover", "licensed-cover", "bob-dylan-cover"].includes(t)),
    originalArtist: valueOf("original-artist") ? titleCase(valueOf("original-artist")) : null,
    album: valueOf("album") ? titleCase(valueOf("album")) : song?.album || null,
    performers: Object.entries(people).map(([p, roles]) => ({ name: titleCase(p), roles: [...new Set(roles)] })),
    venue: valueOf("venue") ? titleCase(valueOf("venue")) : null,
    city: valueOf("city") ? titleCase(valueOf("city")) : null,
    recordedOn: ymd && /^\d{6}$/.test(ymd) ? `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}` : null,
    realFootage: !synthetic && tags.some((t) => ["studio-session", "live", "real-footage"].includes(t)),
    aiGenerated: synthetic,
    linksInCaptionAreClickable: CLICKABLE.has(slot.destination),
    // False on platforms with a promo cap (X) for the posts that stay a plain clip: no link, no ask.
    promotional,
    primaryLink: sectorLinks[0] || null,
    songHasOwnStreamingLink: Boolean(song?.spotifyUrl || song?.appleMusicUrl || song?.youtubeMusicUrl),
    allowedLinks: [...new Set([...sectorLinks, ...artistLinks, links.youtubeChannel, links.booking?.page, links.radio, links.merchStore].filter(Boolean))],
    bookingEmail: promotional && slot.sector === "live-shows" ? links.booking?.email || null : null,
    // Goal #1 (subscribers) closes posts where the brand allows it; radio posts already ask people to join.
    subscribeReminder: !promotional || slot.sector === "radio" ? null : (links.subscribeReminders || {})[slot.destination] || null,
    contentGroup: asset.contentGroup || null,
    notes: asset.creativeNotes ? String(asset.creativeNotes).slice(0, 500) : null
  };
}

function hashtagsFor(f) {
  const tags = ["#stashbox"];
  if (f.show === "Stashbox Does Dylan") tags.push("#bobdylan", "#dylancover");
  if (f.show === "Stashbox Does Sublime & Reggae") tags.push("#sublime", "#reggae");
  if (f.sector === "live-shows") tags.push("#southflorida", "#liveband");
  if (f.sector === "radio") tags.push("#stashboxradio", "#newmusic");
  if (f.sector === "streaming") tags.push("#spotify", "#newmusic");
  return [...new Set(tags)];
}

/** Deterministic fallback copy. Returns null when the sector's required link is missing. */
export function templateCopy(f, seed) {
  if (!f.primaryLink) return null;
  if (f.promotional === false) return plainCopy(f, seed);
  const credited = f.originalArtist && f.song?.toLowerCase().includes(f.originalArtist.toLowerCase());
  const songLine = f.song ? (f.isCover && f.originalArtist && !credited ? `${f.song} (${f.originalArtist})` : f.song) : null;
  const where = f.realFootage && f.venue ? ` at ${f.venue}${f.city ? `, ${f.city}` : ""}` : "";
  const cta = f.linksInCaptionAreClickable ? f.primaryLink : "Link in bio.";
  let hook;
  let body;
  if (f.sector === "live-shows") {
    hook = pick(seed, [
      `${f.show || "Stashbox"}: ${songLine || "live"}${where}.`,
      `${songLine || "This one"}, the ${f.show || "Stashbox"} way${where}.`,
      `${f.show || "Stashbox"} plays ${songLine || "it live"}${where}.`
    ]);
    body = `Booking venues and events in South Florida. ${f.linksInCaptionAreClickable ? `Book the show: ${cta}` : cta}` +
      (f.bookingEmail ? ` Or email ${f.bookingEmail}.` : "");
  } else if (f.sector === "radio") {
    hook = pick(seed, [`${songLine || "New Stashbox song"}.`, `Now on Stashbox Radio: ${songLine}.`, `${songLine}, by Stashbox.`]);
    body = pick(seed + "cta", [
      `Listen free on Stashbox Radio, no login needed. ${cta}`,
      `Play the full song on Stashbox Radio. Join free for the dynamic videos. ${cta}`,
      `Full song on Stashbox Radio. Free members get the videos and their own playlists. ${cta}`
    ]);
  } else {
    hook = pick(seed, [`${songLine || "Stashbox"}.`, `${songLine}, out now.`, `Stream ${songLine}.`]);
    body = f.songHasOwnStreamingLink
      ? `Listen on Spotify: ${cta}`
      : `${f.album ? `From ${f.album}. ` : ""}Follow Stashbox on Spotify: ${cta}`;
  }
  const hashtags = hashtagsFor(f).slice(0, LIMITS[f.destination]?.hashtags ?? 5);
  const caption = `${hook}\n${body}${f.subscribeReminder ? `\n${f.subscribeReminder}` : ""}`;
  return {
    status: "ready", source: "template", angle: f.sector === "live-shows" ? "moment" : "audience", hook,
    caption: f.destination === "youtube" ? null : caption,
    title: f.destination === "youtube" ? `${f.show ? `${f.show}: ` : ""}${f.song || "Stashbox"}${f.realFootage ? " (live)" : ""}`.slice(0, 70) : null,
    description: f.destination === "youtube" ? `${caption}\n\n${hashtags.join(" ")}` : null,
    hashtags, primaryLink: f.primaryLink, onScreenText: null, notes: []
  };
}

/** A clip with no link or ask, for the share of X posts above the promo cap. */
function plainCopy(f, seed) {
  const credited = f.originalArtist && f.song?.toLowerCase().includes(f.originalArtist.toLowerCase());
  const songLine = f.song ? (f.isCover && f.originalArtist && !credited ? `${f.song} (${f.originalArtist} cover)` : f.song) : null;
  const where = f.realFootage && f.venue ? ` at ${f.venue}` : "";
  const hook = pick(seed, [
    `${songLine || "Stashbox"}${where}.`,
    `${f.show ? `${f.show}: ` : ""}${songLine || "this one"}${where}.`,
    `${songLine ? `${songLine}, ` : ""}Stashbox${f.realFootage ? " live" : ""}${where}.`
  ]);
  const hashtags = hashtagsFor(f).slice(0, LIMITS[f.destination]?.hashtags ?? 2);
  return { status: "ready", source: "template", angle: "moment", hook, caption: hook, title: null, description: null,
    hashtags, primaryLink: null, onScreenText: null, notes: ["plain post (promo cap)"] };
}

/** Which posts of one account-week may carry a link or ask, spread evenly (e.g. 1 in 4 at 0.25). */
export function promotionalSlotIds(slots, maxShare = {}) {
  const promo = new Set();
  const byAccount = new Map();
  for (const s of slots) (byAccount.get(s.socialAccountId) || byAccount.set(s.socialAccountId, []).get(s.socialAccountId)).push(s);
  for (const list of byAccount.values()) {
    const share = maxShare[list[0].destination];
    if (share == null) { for (const s of list) promo.add(s.slotId); continue; }
    list.sort((a, b) => a.slotId.localeCompare(b.slotId));
    // Even spacing plus a one-step shift each time, so promos rotate through the day's times.
    const count = Math.floor(list.length * share);
    for (let k = 0; k < count; k++) promo.add(list[(Math.floor((k * list.length) / count) + k) % list.length].slotId);
  }
  return promo;
}

/** Code-side checks on any copy (AI or template). Returns a list of problems. */
export function validateCopy(copy, f) {
  const problems = [];
  const limits = LIMITS[f.destination] || {};
  const text = [copy.caption, copy.title, copy.description, copy.firstComment, copy.onScreenText].filter(Boolean).join("\n");
  for (const url of text.match(/https?:\/\/[^\s)]+/g) || []) {
    const clean = url.replace(/[.,!?]+$/, "");
    if (!f.allowedLinks.includes(clean)) problems.push(`link not from records: ${clean}`);
  }
  if (/\$\s?\d/.test(text)) problems.push("mentions a price");
  for (const re of BANNED) if (re.test(text)) problems.push(`banned phrase: ${re.source}`);
  if (f.destination === "youtube" && !copy.title) problems.push("missing title");
  if (f.destination !== "youtube" && !copy.caption) problems.push("missing caption");
  if (copy.caption && limits.caption && copy.caption.length > limits.caption) problems.push("caption too long");
  if (copy.title && limits.title && copy.title.length > limits.title) problems.push("title too long");
  if (copy.description && limits.description && copy.description.length > limits.description) problems.push("description too long");
  if ((copy.hashtags || []).length > (limits.hashtags ?? 5)) problems.push("too many hashtags");
  if (f.promotional === false && /https?:\/\/|\blink in bio\b|\bbook (us|the show)\b/i.test(text)) problems.push("link or ask in a plain post (promo cap)");
  if (f.aiGenerated && /\b(live footage|real footage|filmed live)\b/i.test(text)) problems.push("presents AI-made video as real footage");
  if (f.isCover && f.originalArtist) {
    const surname = f.originalArtist.split(" ").slice(-1)[0].toLowerCase();
    if (!text.toLowerCase().includes(surname) && !/\bcover\b/i.test(text)) problems.push("cover not credited");
  }
  return problems;
}

function parseCopy(text) {
  const body = String(text).replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Write copy for every planned slot. `invoke` is the Bedrock call (same shape as
 * the curator's); without a model, template copy is used for all posts.
 */
export async function writeWeekCopy({ slots, assetsById, songFacts, links, brandSlug, modelId, invoke, recentCaptionsByAccount = {}, concurrency = 6, intelligenceRoot, promotionalMaxShare = {} }) {
  const written = [];
  const promo = promotionalSlotIds(slots, promotionalMaxShare);
  return mapLimit(slots, concurrency, async (slot) => {
    const asset = assetsById.get(slot.assetId);
    const f = postFacts(asset, slot, songFacts, links, { promotional: promo.has(slot.slotId) });
    const fallback = () => {
      const t = templateCopy(f, slot.slotId);
      return t ? { ...t, problems: validateCopy(t, f) } : { status: "blocked", source: "template", missing: ["primaryLink"], problems: [] };
    };
    if (!modelId || !invoke) return { slotId: slot.slotId, facts: f, copy: fallback() };
    try {
      const g = buildGuidance("write_copy", { brand: brandSlug, destination: slot.destination, sectors: [slot.sector] }, intelligenceRoot);
      const recent = [...(recentCaptionsByAccount[slot.socialAccountId] || []), ...written.filter((w) => w.socialAccountId === slot.socialAccountId).map((w) => w.text)].slice(-20);
      const user = JSON.stringify({ slot: { destination: slot.destination, placement: slot.placement, sector: slot.sector, date: slot.ymd },
        asset: { filename: asset.filename, contentGroup: asset.contentGroup, tags: (asset.tags || []).slice(0, 30) }, facts: f, recentCaptions: recent });
      const ai = parseCopy(await invoke({ modelId, system: g.guidance, user }));
      if (ai.status === "blocked") return { slotId: slot.slotId, facts: f, copy: { ...fallback(), aiBlocked: ai.missing || [] } };
      const copy = {
        status: "ready", source: "ai", angle: ai.angle || null, hook: ai.hook || null,
        caption: ai.caption || null, title: ai.title || null, description: ai.description || null,
        onScreenText: ai.onScreenText || null, firstComment: ai.firstComment || null,
        hashtags: Array.isArray(ai.hashtags) ? ai.hashtags.map(String).slice(0, 10) : [],
        primaryLink: ai.primaryLink || null, notes: Array.isArray(ai.notes) ? ai.notes.slice(0, 5) : [],
        intelligenceVersion: g.intelligenceVersion
      };
      const problems = validateCopy(copy, f);
      if (problems.length) return { slotId: slot.slotId, facts: f, copy: { ...fallback(), aiRejected: problems } };
      written.push({ socialAccountId: slot.socialAccountId, text: copy.caption || copy.title });
      return { slotId: slot.slotId, facts: f, copy: { ...copy, problems } };
    } catch (error) {
      return { slotId: slot.slotId, facts: f, copy: { ...fallback(), aiError: error instanceof Error ? error.message : String(error) } };
    }
  });
}
