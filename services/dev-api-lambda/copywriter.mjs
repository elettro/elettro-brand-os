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
  x: { caption: 280, hashtags: 2 },
  linkedin: { caption: 3000, hashtags: 3 },
  // Threads rejects posts over 500 characters and takes one topic tag per post.
  threads: { caption: 500, hashtags: 1 },
  // Bluesky: 300 characters (graphemes); links and #tags become clickable facets.
  bluesky: { caption: 300, hashtags: 1, links: 1 },
  // Mastodon: 500 characters (every link counts as 23); #tags and links are clickable. Scheduled posts never @mention accounts.
  mastodon: { caption: 500, hashtags: 3 },
  // Substack: a post with a title and a short body under one picture; no hashtags. Scheduled posts never email subscribers.
  substack: { title: 150, caption: 1200, hashtags: 0 },
  // Snapchat: a Spotlight description is 160 characters (hashtags count); Stories carry no text. No links.
  snapchat: { caption: 160, hashtags: 2 },
  // Pinterest: searchable title + keyword description; hashtags do little there. The Pin itself links out.
  pinterest: { title: 100, caption: 800, hashtags: 0 }
};
const CLICKABLE = new Set(["youtube", "facebook", "x", "linkedin", "threads", "bluesky", "mastodon", "substack"]);
const BANNED = [/\belevate\b/i, /\bunleash/i, /\bunlock/i, /\bdive into\b/i, /game[- ]changer/i, /experience the magic/i, /it'?s not just .+, it'?s/i];
const SHOWS = { "stashbox-does-dylan": "Stashbox Does Dylan", "stashbox-does-sublime": "Stashbox Does Sublime & Reggae" };
const ROLE_WORDS = { vocals: "vocals", guitar: "guitar", bass: "bass", drums: "drums", keyboards: "keys", keys: "keys" };

const titleCase = (slug) => String(slug).split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const pick = (seed, list) => list[parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % list.length];

/** The product page for an asset tagged with its Shopify handle, on the brand's own store; null when there is no handle. */
export function productUrlFromTags(tags, links = {}) {
  const lower = (tags || []).map((t) => String(t).toLowerCase());
  const handle = lower.find((t) => t.startsWith("product:"))?.slice("product:".length) ||
    (lower.includes("product-link") ? lower.find((t) => t.startsWith("produkt-"))?.slice("produkt-".length) : null);
  if (!handle || !/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  const root = links.merchStore || links.site;
  if (!root) return null;
  try { return `${new URL(root).origin}/products/${handle}`; } catch { return null; }
}

/** Everything a caption may state about this post, from records only. */
export function postFacts(asset, slotIn, songFacts = {}, links = {}, { promotional = true, language = "en" } = {}) {
  const tags = (asset.tags || []).map((t) => String(t).toLowerCase());
  // A product is captioned as a product even when the planner filled a show/song slot with it (a tee can carry song tags).
  const slot = tags.includes("merch") && slotIn.sector !== "merch" ? { ...slotIn, sector: "merch" } : slotIn;
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
    // A song without its own radio page points to Stashbox Radio itself (worded as "more music", not "this song").
    radio: song?.radioUrl ? [song.radioUrl] : links.radio ? [links.radio] : [],
    // Spotify first (song, then artist profile), then the other platforms.
    streaming: [song?.spotifyUrl, links.streaming?.spotify, song?.appleMusicUrl, song?.youtubeMusicUrl,
      links.streaming?.appleMusic, links.streaming?.amazonMusic, links.streaming?.tidal].filter(Boolean),
    // A product post points at the brand's store.
    merch: links.merchStore ? [links.merchStore] : []
  }[slot.sector] || [];
  const artistLinks = Object.values(links.streaming || {}).filter(Boolean);
  // Every Pin carries a destination link (Dean, 261021): the deepest record (song, streaming, booking),
  // else the store for merch, else the brand site (taken from the radio link's origin when not set).
  const site = links.site || (links.radio ? new URL(links.radio).origin : null);
  // German brands (SolarMeister): a product image names its own shop page in its notes ("Link: https://…/products/<slug>").
  // It must be on the brand's own shop, and it beats the shop's root address everywhere a link may go.
  const noteUrl = language === "de" ? /https?:\/\/[^\s)]+\/products\/[^\s)]+/.exec(String(asset.creativeNotes || ""))?.[0].replace(/[.,;!?]+$/, "") : null;
  const noteProductUrl = noteUrl && [links.site, links.merchStore].filter(Boolean).some((root) => noteUrl.startsWith(root.replace(/\/$/, "") + "/")) ? noteUrl : null;
  // Any brand: a Shopify product asset carries its handle in a tag (Stashbox `product:<handle>`, SolarMeister `produkt-<handle>` with
  // `product-link`), so the post links to that product's page. Without a handle it falls back to the store/site address.
  const productUrl = noteProductUrl || productUrlFromTags(tags, links);
  // Radio and streaming posts still need their song link, as on every network.
  const pinLink = slot.destination === "pinterest" && !sectorLinks.length && !["radio", "streaming"].includes(slot.sector)
    ? (slot.sector === "merch" && links.merchStore) || site || null : null;
  return {
    language,
    sector: slot.sector,
    destination: slot.destination,
    placement: slot.placement,
    song: slug && slot.sector !== "merch" ? song?.title || asset.topic || titleCase(slug) : null,
    // A product post (Shopify item) is named by the asset's own title, e.g. "Rastaman Portrait AOP Tee".
    product: slot.sector === "merch" ? String(asset.title || asset.topic || "").trim() || null : null,
    // The asset's own name, the only title a non-Stashbox brand's template may use.
    assetName: String(asset.title || asset.topic || "").trim() || null,
    show: showTag && slot.sector !== "merch" ? SHOWS[showTag] : null,
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
    primaryLink: productUrl || sectorLinks[0] || pinLink,
    songHasOwnStreamingLink: Boolean(song?.spotifyUrl || song?.appleMusicUrl || song?.youtubeMusicUrl),
    songHasRadioPage: Boolean(song?.radioUrl),
    genre: ["reggae", "rock", "blues", "folk", "ska", "dub", "funk", "soul", "jazz", "psychedelic"].find((g) => tags.includes(g)) || null,
    allowedLinks: [...new Set([productUrl, ...sectorLinks, ...artistLinks, links.youtubeChannel, links.booking?.page, links.radio, links.merchStore, pinLink].filter(Boolean))],
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
  if (f.sector === "merch") tags.push("#stashboxmerch");
  return [...new Set(tags)];
}

// ---------- German brands (Brand.settings.planner.language = "de") ----------
// Every word a German brand posts is German: the templates below, the AI (told so in the brand's brand.md),
// and validateCopy, which refuses any text that reads as English.

const ENGLISH_WORDS = /\b(the|and|with|your|you|our|link in bio|learn more|shop now|check out|new in|now in|out now|more from|follow|for more|listen|watch|tap the pin|available|discover)\b/gi;

/** Distinct English words found in a text. German text with a product name or two stays under the limit. */
export function englishWordsIn(text) {
  return [...new Set((String(text || "").match(ENGLISH_WORDS) || []).map((w) => w.toLowerCase()))];
}

/** The asset's German title without leftovers like "(SolarMeister, 16x9)" or a bare ratio. */
export function cleanGermanName(name) {
  return String(name || "")
    .replace(/\.(?:png|jpe?g|webp|gif|mp4|mov)$/i, "")
    .replace(/\s*\(\d{1,3}\)\s*$/, "")
    .replace(/-\d{1,3}$/, "")
    .replace(/\s*\([^)]*(?:\d+x\d+|solarmeister)[^)]*\)\s*/gi, " ")
    .replace(/\b\d+x\d+\b/g, " ")
    .replace(/_+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** Neckermann Strom (dynamic-tariff Ökostrom supplier; calm, factual, du-form, no prices, no exclamation marks, no emoji; asks are the brand brief's house-style lines). Never SolarMeister's shop wording. */
const NS_ASKS = [
  "Strom kostet nicht jede Stunde gleich viel. Dein Tarif muss das auch nicht.",
  "Alle Preisbestandteile auf einen Blick. Ohne Kleingedrucktes.",
  "Transparent. Nachvollziehbar. 100 % Ökostrom.",
  "Wechsel in wenigen Minuten. Die Kündigung beim alten Anbieter übernehmen wir."
];
const NS_HASHTAGS = ["#neckermannstrom", "#ökostrom", "#energie"];

const DE_HASHTAGS = {
  produkte: ["#solarmeister", "#balkonkraftwerk", "#photovoltaik"],
  weihnachten: ["#solarmeister", "#weihnachten", "#frohefesttage"],
  reportagen: ["#solarmeister", "#solarenergie", "#photovoltaik"]
};

/** German template copy: the asset's own German name, one plain German line per sector, the brand site as the only link. */
function germanTemplateCopy(f, seed) {
  const name = cleanGermanName(f.song || f.product || f.assetName);
  if (!name) return null;
  const youtube = f.destination === "youtube";
  const titled = youtube || f.destination === "pinterest";
  // The product's own page when the asset names one, else the shop's root address; no link on the plain posts under a promo cap.
  const link = f.promotional === false ? null : f.primaryLink || f.allowedLinks[0] || null;
  const clickable = Boolean(link) && f.linksInCaptionAreClickable;
  const ns = f.brandSlug === "neckermann-strom";
  const ask = f.promotional === false ? null : ns ? pick(seed + "ask", NS_ASKS) : f.sector === "weihnachten"
    ? pick(seed + "ask", ["Frohe Weihnachten von deinem SolarMeister-Team.", "Schöne Feiertage wünscht dir SolarMeister.", "Ein sonniges Weihnachtsfest wünscht dir SolarMeister."])
    : pick(seed + "ask", [
        "Einfach selbst installieren: Balkonkraftwerke und Zubehör im SolarMeister Shop.",
        "Solar zum Selbermachen. Alles dafür findest du im SolarMeister Shop.",
        "Dein Balkonkraftwerk beginnt im SolarMeister Shop."]);
  const where = !ask ? null : clickable ? `${ask} ${link}` : link ? `${ask} Link in der Bio.` : ask;
  const caption = [name, where].filter(Boolean).join("\n");
  const hashtags = (ns ? NS_HASHTAGS : DE_HASHTAGS[f.sector] || DE_HASHTAGS.produkte).slice(0, LIMITS[f.destination]?.hashtags ?? 3);
  return {
    status: "ready", source: "template", angle: null, hook: name,
    caption: youtube ? null : caption,
    title: titled ? name.slice(0, 70) : null,
    description: youtube ? `${caption}\n\n${hashtags.join(" ")}` : null,
    hashtags, primaryLink: link, onScreenText: null,
    notes: ["deutsche Vorlage: Titel des Bildes plus ein Satz; vor der Freigabe bei Bedarf bearbeiten"]
  };
}

/** Every template below is written in Stashbox's voice; any other brand must never fall back to it. */
const isOtherBrand = (f) => Boolean(f.brandSlug) && f.brandSlug !== "stashbox";

/**
 * Template copy for a brand that has no templates of its own: the asset's name and nothing else
 * (no brand wording, hashtags, link or ask). It is a draft to edit on Review; no name means no draft.
 */
function neutralCopy(f) {
  const name = f.song || f.product || f.assetName;
  if (!name) return null;
  const youtube = f.destination === "youtube";
  const titled = youtube || f.destination === "pinterest";
  return {
    status: "ready", source: "template", angle: null, hook: name,
    caption: youtube ? null : name,
    title: titled ? name.slice(0, 70) : null,
    description: youtube ? name : null,
    hashtags: [], primaryLink: null, onScreenText: null,
    notes: ["no copy templates for this brand: asset name only, edit before approving"]
  };
}

/**
 * Deterministic fallback copy. When the sector's link is missing (e.g. a song with no radio page or
 * streaming link on file) the post gets a plain caption with no link or ask, never a blank one.
 */
export function templateCopy(f, seed) {
  if (f.language === "de" && isOtherBrand(f)) return germanTemplateCopy(f, seed);
  if (isOtherBrand(f)) return neutralCopy(f);
  if (!f.primaryLink) return { ...plainCopy(f, seed), notes: ["no link on file for this pillar: plain caption"] };
  if (f.promotional === false) return plainCopy(f, seed);
  const credited = f.originalArtist && f.song?.toLowerCase().includes(f.originalArtist.toLowerCase());
  const songLine = f.song ? (f.isCover && f.originalArtist && !credited ? `${f.song} (${f.originalArtist})` : f.song) : null;
  const where = f.realFootage && f.venue ? ` at ${f.venue}${f.city ? `, ${f.city}` : ""}` : "";
  const cta = f.linksInCaptionAreClickable ? f.primaryLink : f.destination === "pinterest" ? "Tap the Pin." : "Link in bio.";
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
  } else if (f.sector === "radio" && !f.songHasRadioPage) {
    // The song isn't on Stashbox Radio; the link is the radio itself, so the ask is "more music", not this song.
    hook = pick(seed, [`${songLine || "Stashbox"}.`, `${songLine ? `${songLine}, by ` : ""}Stashbox.`]);
    body = pick(seed + "cta", [
      `More Stashbox music on Stashbox Radio, free to listen. ${cta}`,
      `More originals on Stashbox Radio, no login needed. ${cta}`,
      `Hear more on Stashbox Radio. Join free for the dynamic videos. ${cta}`
    ]);
  } else if (f.sector === "radio") {
    hook = pick(seed, [`${songLine || "New Stashbox song"}.`, `Now on Stashbox Radio: ${songLine}.`, `${songLine}, by Stashbox.`]);
    body = pick(seed + "cta", [
      `Listen free on Stashbox Radio, no login needed. ${cta}`,
      `Play the full song on Stashbox Radio. Join free for the dynamic videos. ${cta}`,
      `Full song on Stashbox Radio. Free members get the videos and their own playlists. ${cta}`
    ]);
  } else if (f.sector === "merch" && f.product) {
    hook = `${f.product}.`;
    body = pick(seed + "cta", [
      `New in the Stashbox merch store. ${cta}`,
      `Now in the Stashbox store. ${cta}`,
      `Find it in the Stashbox merch store. ${cta}`
    ]);
  } else if (f.destination === "pinterest" && f.sector !== "streaming") {
    // Pinterest only: merch, blog and other sectors pin to the store or the brand site.
    hook = `${songLine || "Stashbox"}${f.show ? `, ${f.show}` : ""}.`;
    body = f.sector === "merch" ? `Stashbox merch. ${cta}` : `More from Stashbox. ${cta}`;
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
    title: f.destination === "youtube" || f.destination === "pinterest"
      ? `${f.show ? `${f.show}: ` : ""}${f.song || f.product || "Stashbox"}${f.realFootage ? " (live)" : ""}`.slice(0, 70) : null,
    description: f.destination === "youtube" ? `${caption}\n\n${hashtags.join(" ")}` : null,
    hashtags, primaryLink: f.primaryLink, onScreenText: null, notes: []
  };
}

/** A clip with no link or ask: X posts above the promo cap, and posts whose pillar link is missing. */
function plainCopy(f, seed) {
  const credited = f.originalArtist && f.song?.toLowerCase().includes(f.originalArtist.toLowerCase());
  const songLine = f.song ? (f.isCover && f.originalArtist && !credited ? `${f.song} (${f.originalArtist} cover)` : f.song) : f.product || null;
  const where = f.realFootage && f.venue ? ` at ${f.venue}` : "";
  const hook = pick(seed, [
    `${songLine || "Stashbox"}${where}.`,
    `${f.show ? `${f.show}: ` : ""}${songLine || "this one"}${where}.`,
    `${songLine ? `${songLine}, ` : ""}Stashbox${f.realFootage ? " live" : ""}${where}.`
  ]);
  // Without the pillar's link, its hashtags (#spotify, #stashboxradio) would point nowhere.
  const linkTags = f.primaryLink ? [] : ["#spotify", "#stashboxradio"];
  const hashtags = hashtagsFor(f).filter((t) => !linkTags.includes(t)).slice(0, LIMITS[f.destination]?.hashtags ?? 2);
  // One line of context from the records, so a plain post still says something about the clip.
  const genre = f.genre ? `${f.genre[0].toUpperCase()}${f.genre.slice(1)}` : null;
  const context = [
    f.isCover && f.originalArtist && !hook.includes(f.originalArtist) ? `Stashbox's take on ${f.originalArtist}.` : null,
    !f.isCover && f.song ? (f.genre ? `A ${f.genre} original by Stashbox.` : "A Stashbox original.") : null,
    f.show && !hook.includes(f.show) ? `From the ${f.show} set.` : null,
    f.album ? `From ${f.album}.` : null,
    f.realFootage && f.venue && !where ? `Recorded live at ${f.venue}${f.city ? `, ${f.city}` : ""}.` : null,
    genre && f.isCover ? `${genre} from South Florida.` : null
  ].filter(Boolean);
  const contextLine = context.length ? pick(seed + "context", context) : null;
  // A soft ask with no link, only where the post may carry one (not X's plain promo-cap posts).
  const ask = f.promotional === false ? null : f.subscribeReminder || pick(seed + "ask", [
    "Follow Stashbox for more.", "More from Stashbox every week. Follow along.", "South Florida's Stashbox. Follow for more."
  ]);
  const limit = LIMITS[f.destination]?.caption || 2200;
  const caption = [hook, contextLine, ask].filter(Boolean).reduce((text, line) =>
    !text ? line : `${text}\n${line}`.length <= limit ? `${text}\n${line}` : text, "");
  // YouTube posts are a title plus a description; everything else is a caption.
  const youtube = f.destination === "youtube";
  return { status: "ready", source: "template", angle: "moment", hook, caption: youtube ? null : caption,
    title: youtube || f.destination === "pinterest"
      ? `${f.show ? `${f.show}: ` : ""}${f.song || f.product || "Stashbox"}${f.realFootage ? " (live)" : ""}`.slice(0, 70) : null,
    description: youtube ? `${caption}\n\n${hashtags.join(" ")}` : null,
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

const graphemes = (text) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(String(text))].length;
// A handle-shaped @name would notify that account; scheduled Bluesky posts must not (automated notifications count as spam).
const MENTION = /(^|[\s(])@[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+/i;

// Mastodon mentions are @name or @name@instance.
const MASTODON_MENTION = /(^|[s(])@[a-z0-9_]+(@[a-z0-9.-]+.[a-z]{2,})?/i;

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
  if (f.language === "de") {
    const english = englishWordsIn(text);
    if (english.length >= 2) problems.push(`not German: ${english.join(", ")}`);
    if (/\blink in bio\b|\bshop now\b/i.test(text)) problems.push("English call to action on a German brand");
  }
  if (isOtherBrand(f) && /stashbox/i.test(text) && !/stashbox/i.test(f.assetName || "")) problems.push(`mentions Stashbox on the ${f.brandSlug} brand`);
  for (const re of BANNED) if (re.test(text)) problems.push(`banned phrase: ${re.source}`);
  if ((f.destination === "youtube" || f.destination === "pinterest") && !copy.title) problems.push("missing title");
  if (f.destination !== "youtube" && !copy.caption) problems.push("missing caption");
  // Bluesky counts graphemes, and a link counts in full (it is not shortened), so a long URL eats the 300.
  const captionLength = f.destination === "bluesky" ? graphemes(copy.caption || "") : (copy.caption || "").length;
  if (copy.caption && limits.caption && captionLength > limits.caption) problems.push("caption too long");
  if (f.destination === "bluesky") {
    if ((text.match(/https?:\/\/\S+/g) || []).length > (limits.links ?? 1)) problems.push("more than one link in a Bluesky post");
    if (MENTION.test(text)) problems.push("@mention in a scheduled Bluesky post (notifications from automation count as spam)");
  }
  if (f.destination === "mastodon" && MASTODON_MENTION.test(text)) problems.push("@mention in a scheduled Mastodon post (notifications from automation count as spam)");
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
export async function writeWeekCopy({ slots, assetsById, songFacts, links, brandSlug, modelId, invoke, recentCaptionsByAccount = {}, concurrency = 6, intelligenceRoot, promotionalMaxShare = {}, language = "en" }) {
  const written = [];
  const promo = promotionalSlotIds(slots, promotionalMaxShare);
  return mapLimit(slots, concurrency, async (slot) => {
    const asset = assetsById.get(slot.assetId);
    const f = { ...postFacts(asset, slot, songFacts, links, { promotional: promo.has(slot.slotId), language }), brandSlug };
    const fallback = () => {
      const t = templateCopy(f, slot.slotId);
      return t ? { ...t, problems: validateCopy(t, f) } : { status: "blocked", source: "template", missing: [isOtherBrand(f) ? "assetName" : "primaryLink"], problems: [] };
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

/** True when a caption fits the network's own limit (Bluesky counts graphemes, like validateCopy). */
export function captionFits(destination, caption) {
  const limit = LIMITS[destination]?.caption;
  if (!limit) return true;
  return (destination === "bluesky" ? graphemes(caption || "") : String(caption || "").length) <= limit;
}
