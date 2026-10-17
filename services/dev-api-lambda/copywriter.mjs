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
  facebook: { caption: 5000, hashtags: 2 }
};
const CLICKABLE = new Set(["youtube", "facebook"]);
const BANNED = [/\belevate\b/i, /\bunleash/i, /\bunlock/i, /\bdive into\b/i, /game[- ]changer/i, /experience the magic/i, /it'?s not just .+, it'?s/i];
const SHOWS = { "stashbox-does-dylan": "Stashbox Does Dylan", "stashbox-does-sublime": "Stashbox Does Sublime & Reggae" };
const ROLE_WORDS = { vocals: "vocals", guitar: "guitar", bass: "bass", drums: "drums", keyboards: "keys", keys: "keys" };

const titleCase = (slug) => String(slug).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const pick = (seed, list) => list[parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % list.length];

/** Everything a caption may state about this post, from records only. */
export function postFacts(asset, slot, songFacts = {}, links = {}) {
  const tags = (asset.tags || []).map((t) => String(t).toLowerCase());
  const valueOf = (prefix) => tags.find((t) => t.startsWith(prefix + ":"))?.slice(prefix.length + 1) || null;
  const slug = songKeyOf(asset);
  const song = slug ? songFacts[slug] : null;
  const showTag = Object.keys(SHOWS).find((t) => tags.includes(t));
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
    streaming: [song?.spotifyUrl, song?.appleMusicUrl, song?.youtubeMusicUrl].filter(Boolean)
  }[slot.sector] || [];
  return {
    sector: slot.sector,
    destination: slot.destination,
    placement: slot.placement,
    song: song?.title || asset.topic || (slug ? titleCase(slug) : null),
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
    primaryLink: sectorLinks[0] || null,
    allowedLinks: [...new Set([...sectorLinks, links.booking?.page, links.radio, links.merchStore].filter(Boolean))],
    bookingEmail: slot.sector === "live-shows" ? links.booking?.email || null : null,
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
  return [...new Set(tags)];
}

/** Deterministic fallback copy. Returns null when the sector's required link is missing. */
export function templateCopy(f, seed) {
  if (!f.primaryLink) return null;
  const songLine = f.song ? (f.isCover && f.originalArtist ? `${f.song} (${f.originalArtist})` : f.song) : null;
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
    hook = `${songLine || "Stashbox"}.`;
    body = `Listen on your platform: ${cta}`;
  }
  const hashtags = hashtagsFor(f).slice(0, LIMITS[f.destination]?.hashtags ?? 5);
  const caption = `${hook}\n${body}`;
  return {
    status: "ready", source: "template", angle: f.sector === "live-shows" ? "moment" : "audience", hook,
    caption: f.destination === "youtube" ? null : caption,
    title: f.destination === "youtube" ? `${f.show ? `${f.show}: ` : ""}${f.song || "Stashbox"}${f.realFootage ? " (live)" : ""}`.slice(0, 70) : null,
    description: f.destination === "youtube" ? `${caption}\n\n${hashtags.join(" ")}` : null,
    hashtags, primaryLink: f.primaryLink, onScreenText: null, notes: []
  };
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
export async function writeWeekCopy({ slots, assetsById, songFacts, links, brandSlug, modelId, invoke, recentCaptionsByAccount = {}, concurrency = 6, intelligenceRoot }) {
  const written = [];
  return mapLimit(slots, concurrency, async (slot) => {
    const asset = assetsById.get(slot.assetId);
    const f = postFacts(asset, slot, songFacts, links);
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
