import test from "node:test";
import assert from "node:assert/strict";
import { buildSongFacts, matchSong } from "../services/dev-api-lambda/song-facts.mjs";
import { postFacts, promotionalSlotIds, templateCopy, validateCopy, writeWeekCopy } from "../services/dev-api-lambda/copywriter.mjs";
import { planWeek, resolvePlannerSettings } from "../services/dev-api-lambda/planner-v2.mjs";

const catalog = [
  { song_key: "help-jamaica-now-stashbox", song_name: "Help Jamaica Now", display_title: "Help Jamaica Now", public_visibility: "visible", total_plays: 3 },
  { song_key: "crowd-of-two-001b-stashbox", song_name: "Crowd of Two", public_visibility: "visible", total_plays: 1 },
  { song_key: "crowd-of-two-0005a-stashbox", song_name: "Crowd of Two (alt)", public_visibility: "visible", total_plays: 9 },
  { song_key: "hidden-song-stashbox", song_name: "Hidden Song", public_visibility: "hidden" },
  { song_key: "palm-trees-stashbox", song_name: "Palm Trees", public_visibility: "visible", spotify_url: "https://open.spotify.com/track/x" }
];
const links = { booking: { page: "https://stashbox.com/booking/", email: "booking@stashbox.com" }, radio: "https://stashbox.com/radio/", merchStore: "https://stashbox.ai" };

test("song slugs map to one radio record; hidden songs and unknown songs get no page", () => {
  assert.equal(matchSong("help-jamaica-now", catalog).song.song_key, "help-jamaica-now-stashbox");
  const crowd = matchSong("crowd-of-two", catalog);
  // The version whose title matches exactly wins; other versions are listed for review.
  assert.equal(crowd.song.song_key, "crowd-of-two-001b-stashbox");
  assert.deepEqual(crowd.alternatives, ["crowd-of-two-0005a-stashbox"]);
  const facts = buildSongFacts(["help-jamaica-now", "hidden-song", "tangled-up-in-blue"], catalog,
    { overrides: { "help-jamaica-now": "help-jamaica-now-stashbox" } });
  assert.equal(facts["help-jamaica-now"].radioUrl, "https://stashbox.com/radio/?song=help-jamaica-now-stashbox");
  assert.equal(facts["hidden-song"].inCatalog, false);
  assert.equal(facts["tangled-up-in-blue"].inCatalog, false);
});

test("radio and streaming slots only use songs whose records carry the needed link", () => {
  const settings = resolvePlannerSettings({ planner: {
    sectors: [
      { slug: "radio", priority: 1, share: 0.5, match: { tagsAny: ["music-video"] }, requires: ["radioLink"] },
      { slug: "streaming", priority: 2, share: 0.5, match: { tagsAny: ["music-video"] }, requires: ["streamingLink"] }
    ], minPoolForSector: 1
  } });
  const assets = ["help-jamaica-now", "tangled-up-in-blue", "palm-trees"].map((s, i) => ({
    id: `a${i}`, filename: `${s}.mp4`, kind: "video", aspectRatioLabel: "9x16", tags: ["music-video", `song:${s}`],
    priority: "normal", eligibilityType: "evergreen", allowedDestinations: [], excludedDestinations: []
  }));
  const songFacts = buildSongFacts(["help-jamaica-now", "tangled-up-in-blue", "palm-trees"], catalog);
  const plan = planWeek({ assets, settings, songFacts, weekStart: "2026-10-19", timeZone: "America/New_York", now: new Date("2026-10-17"),
    accounts: [{ socialAccountId: "ig", destination: "instagram", placement: "reel", postsPerWeek: 4, preferredStartTime: "11:00", preferredEndTime: "19:00" }] });
  const used = plan.slots.filter((s) => s.status === "planned");
  assert.ok(used.every((s) => s.songKey !== "tangled-up-in-blue"));
  assert.ok(used.filter((s) => s.sector === "streaming").every((s) => s.songKey === "palm-trees"));
});

const dylanAsset = {
  id: "d1", filename: "261011-stashbox-does-dylan-tangled-up-in-blue-9x16-4K-01.mp4", topic: "Tangled Up in Blue", contentGroup: "Studio One 261011",
  tags: ["song:tangled-up-in-blue", "stashbox-does-dylan", "bob-dylan-cover", "cover", "original-artist:bob-dylan", "studio-session", "live",
    "venue:studio-one", "city:fort-lauderdale", "date:261011", "dean-palermo:guitar", "dean-palermo:vocals", "david-nizri:drums"]
};

test("post facts come from tags and records only", () => {
  const f = postFacts(dylanAsset, { sector: "live-shows", destination: "instagram", placement: "reel", synthetic: false }, {}, links);
  assert.equal(f.show, "Stashbox Does Dylan");
  assert.equal(f.originalArtist, "Bob Dylan");
  assert.equal(f.recordedOn, "2026-10-11");
  assert.equal(f.venue, "Studio One");
  assert.deepEqual(f.performers.find((p) => p.name === "Dean Palermo").roles, ["guitar", "vocals"]);
  assert.equal(f.primaryLink, "https://stashbox.com/booking/");
  assert.equal(f.linksInCaptionAreClickable, false);
  assert.equal(f.realFootage, true);
});

test("template copy credits covers, uses record links, and fits each platform", () => {
  for (const destination of ["instagram", "tiktok", "facebook", "youtube"]) {
    const f = postFacts(dylanAsset, { sector: "live-shows", destination, placement: "reel", synthetic: false }, {}, links);
    const copy = templateCopy(f, `seed-${destination}`);
    assert.deepEqual(validateCopy(copy, f), [], destination);
    const text = copy.caption || copy.description;
    assert.match(text, /Dylan/);
    if (destination === "facebook" || destination === "youtube") assert.match(text, /https:\/\/stashbox\.com\/booking\//);
    else assert.match(text, /Link in bio/);
    if (destination === "youtube") assert.ok(copy.title.length <= 70);
  }
  const radio = postFacts({ ...dylanAsset, tags: ["song:tangled-up-in-blue", "music-video"] }, { sector: "radio", destination: "instagram" }, {}, links);
  // A song without its own radio page links to Stashbox Radio itself, worded as "more music", never "this song".
  const general = templateCopy(radio, "x");
  assert.equal(general.status, "ready");
  assert.equal(general.primaryLink, links.radio);
  assert.ok(!/full song|play the full/i.test(general.caption), general.caption);
  assert.deepEqual(validateCopy(general, radio), []);
  // With no link on file at all: a plain caption with context and no link, never a made-up link or a blank post.
  const bare = postFacts({ ...dylanAsset, tags: ["song:tangled-up-in-blue", "music-video", "reggae"] }, { sector: "radio", destination: "instagram" }, {}, {});
  const plain = templateCopy(bare, "x");
  assert.equal(plain.status, "ready");
  assert.ok(plain.caption && !/https?:\/\/|link in bio/i.test(plain.caption) && plain.caption.includes("\n"), plain.caption);
  assert.equal(plain.primaryLink, null);
  assert.deepEqual(validateCopy(plain, bare), []);
  const ytBare = postFacts({ ...dylanAsset, tags: ["song:tangled-up-in-blue", "music-video"] }, { sector: "radio", destination: "youtube" }, {}, {});
  const yt = templateCopy(ytBare, "x");
  assert.ok(yt.title && yt.description && !yt.caption, "YouTube still gets a title and description");
  assert.deepEqual(validateCopy(yt, ytBare), []);
});

test("X keeps 1 in 4 posts promotional; the rest are plain clips under 280 chars", () => {
  const slots = Array.from({ length: 28 }, (_, i) => ({ socialAccountId: "x1", destination: "x", slotId: `x1:2026-10-${String(19 + Math.floor(i / 4)).padStart(2, "0")}:${["09:00", "13:00", "17:00", "21:00"][i % 4]}` }));
  const promo = promotionalSlotIds([...slots, { socialAccountId: "ig", destination: "instagram", slotId: "ig:1" }], { x: 0.25 });
  assert.equal([...promo].filter((id) => id.startsWith("x1:")).length, 7);
  assert.ok(promo.has("ig:1"), "uncapped platforms are always promotional");
  const plain = postFacts(dylanAsset, { sector: "live-shows", destination: "x", synthetic: false }, {}, links, { promotional: false });
  const copy = templateCopy(plain, "seed-x");
  assert.deepEqual(validateCopy(copy, plain), []);
  assert.doesNotMatch(copy.caption, /https?:|book|link in bio/i);
  assert.ok(copy.caption.length <= 240);
  const ad = postFacts(dylanAsset, { sector: "live-shows", destination: "x", synthetic: false }, {}, links);
  const adCopy = templateCopy(ad, "seed-x");
  assert.deepEqual(validateCopy(adCopy, ad), []);
  assert.match(adCopy.caption, /https:\/\/stashbox\.com\/booking\//);
  assert.match(validateCopy({ caption: "Book us: https://stashbox.com/booking/", hashtags: [] }, plain).join(), /plain post/);
});

test("validation rejects invented links, prices, banned phrases and AI-as-real claims", () => {
  const f = postFacts(dylanAsset, { sector: "live-shows", destination: "facebook", synthetic: true }, {}, links);
  const bad = { caption: "Elevate your night! Live footage, tickets $20 at https://example.com/tix", hashtags: [] };
  const problems = validateCopy(bad, f).join(" | ");
  assert.match(problems, /link not from records/);
  assert.match(problems, /price/);
  assert.match(problems, /banned phrase/);
  assert.match(problems, /AI-made video as real footage/);
  assert.match(problems, /cover not credited/);
});

test("AI copy is used when valid and replaced by the template when it breaks a rule", async () => {
  const slots = [
    { slotId: "s1", socialAccountId: "fb", destination: "facebook", placement: "reel", sector: "live-shows", ymd: "2026-10-19", assetId: "d1", synthetic: false },
    { slotId: "s2", socialAccountId: "fb", destination: "facebook", placement: "reel", sector: "live-shows", ymd: "2026-10-20", assetId: "d1", synthetic: false }
  ];
  let call = 0;
  const invoke = async ({ system }) => {
    assert.ok(system.includes("Copywriting"));
    call += 1;
    return JSON.stringify(call === 1
      ? { status: "ready", angle: "musicianship", hook: "Our take on Dylan's Tangled Up in Blue.", caption: "Our take on Dylan's Tangled Up in Blue, live at Studio One. Book us for your South Florida event: https://stashbox.com/booking/", hashtags: ["#stashbox"] }
      : { status: "ready", caption: "Tangled Up in Blue. Tickets at https://fake.example", hashtags: [] });
  };
  const out = await writeWeekCopy({ slots, assetsById: new Map([["d1", dylanAsset]]), songFacts: {}, links, brandSlug: "stashbox",
    modelId: "test", invoke, concurrency: 1 });
  assert.equal(out[0].copy.source, "ai");
  assert.equal(out[0].copy.angle, "musicianship");
  assert.equal(out[1].copy.source, "template");
  assert.ok(out[1].copy.aiRejected.some((p) => p.includes("link not from records")));
});

test("LinkedIn copy is held to LinkedIn's limits and links are clickable there", () => {
  const f = postFacts({ tags: ["radio-blog"] }, { sector: "radio-blog", destination: "linkedin" }, {}, links);
  assert.equal(f.linksInCaptionAreClickable, true);
  assert.deepEqual(validateCopy({ caption: "Short post.", hashtags: ["#a", "#b", "#c"] }, f), []);
  const problems = validateCopy({ caption: "x".repeat(3001), hashtags: ["#a", "#b", "#c", "#d"] }, f).join(" | ");
  assert.match(problems, /caption too long/);
  assert.match(problems, /too many hashtags/);
});

test("Threads copy is held to 500 characters and one topic tag; links are clickable there", () => {
  const f = postFacts({ tags: ["radio-blog"] }, { sector: "radio-blog", destination: "threads" }, {}, links);
  assert.equal(f.linksInCaptionAreClickable, true);
  assert.deepEqual(validateCopy({ caption: "x".repeat(500), hashtags: ["#stashbox"] }, f), []);
  const problems = validateCopy({ caption: "x".repeat(501), hashtags: ["#a", "#b"] }, f).join(" | ");
  assert.match(problems, /caption too long/);
  assert.match(problems, /too many hashtags/);
});
