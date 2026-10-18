import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planWeek, resolvePlannerSettings, buildSlots, sectorSequence, explorationFlags, poolRejection, songKeyOf, nextWeekStart
} from "../services/dev-api-lambda/planner-v2.mjs";
import { buildGuidance, splitSections } from "../services/dev-api-lambda/intelligence.mjs";
import { curateWeek, parseDecisions } from "../services/dev-api-lambda/curator.mjs";

const TZ = "America/New_York";
const WEEK = "2026-10-19";
const NOW = new Date("2026-10-17T12:00:00Z");

const settings = resolvePlannerSettings({ planner: {
  pool: { kinds: ["video"], aspectRatios: ["9x16"], excludeTagsAny: ["no-audio"] },
  placements: { "tiktok:video": { maxDurationBucket: "1-3min" } },
  sectors: [
    { slug: "live-shows", priority: 1, share: 0.6, match: { tagsAny: ["studio-session"] } },
    { slug: "radio", priority: 2, share: 0.4, match: { tagsAny: ["music-video"] } },
    { slug: "merch", priority: 4, share: 0.2, match: { tagsAny: ["merch"] } }
  ],
  minPoolForSector: 2,
  exploration: { default: 0.25, tiktok: 0.4 },
  cooldowns: { assetDays: 30, songDays: 1, productDays: 15 },
  syntheticTagsAny: ["ai-generated"]
} });

let n = 0;
const asset = (tags, extra = {}) => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
  filename: `clip-${n}.mp4`, kind: "video", aspectRatioLabel: "9x16", tags, contentGroup: extra.group || null,
  priority: "normal", eligibilityType: "evergreen", allowedDestinations: [], excludedDestinations: [],
  createdAt: "2026-10-17T00:00:00Z", ...extra
});

const library = [
  ...["a", "b", "c", "d", "e", "f"].flatMap((s) => [1, 2, 3].map(() => asset(["studio-session", `song:${s}`, "15-30s"], { group: "Session" }))),
  ...["x", "y", "z", "w"].flatMap((s) => [1, 2].map(() => asset(["music-video", `song:${s}`, "ai-generated"], { group: `MV ${s}` }))),
  asset(["studio-session", "song:a", "no-audio"]),
  asset(["studio-session", "song:b"], { aspectRatioLabel: "16x9" }),
  asset(["music-video", "song:x", "3min-plus"])
];

const account = (destination, placement, postsPerWeek, start = "10:00", end = "20:00") => ({
  socialAccountId: `${destination}-${placement}`, destination, placement, accountName: destination, postsPerWeek,
  preferredStartTime: start, preferredEndTime: end, publishingMode: "approval", timezone: TZ
});

const run = (extra = {}) => planWeek({ assets: library, accounts: [account("tiktok", "video", 14), account("youtube", "short", 14)],
  settings, weekStart: WEEK, timeZone: TZ, now: NOW, ...extra });

test("week starts on the next Monday", () => {
  assert.equal(nextWeekStart("2026-10-17"), "2026-10-19");
  assert.equal(nextWeekStart("2026-10-19"), "2026-10-26");
});

test("slots spread posts per week evenly across days and the time window", () => {
  const slots = buildSlots(account("tiktok", "video", 14, "10:00", "20:00"), WEEK, TZ);
  assert.equal(slots.length, 14);
  assert.deepEqual(slots.filter((s) => s.ymd === WEEK).map((s) => s.localTime), ["10:00", "20:00"]);
  assert.equal(slots[0].scheduledFor, "2026-10-19T14:00:00.000Z");
});

test("sector sequence tracks shares and exploration tracks the rate", () => {
  const seq = sectorSequence(10, [{ slug: "a", share: 0.6 }, { slug: "b", share: 0.4 }]);
  assert.equal(seq.filter((s) => s === "a").length, 6);
  assert.equal(explorationFlags(14, 0.4).filter(Boolean).length, 5);
  assert.equal(explorationFlags(14, 0.25).filter(Boolean).length, 3);
});

test("pool rules drop wrong aspect, excluded tags and over-length clips", () => {
  const tiktok = account("tiktok", "video", 14);
  assert.equal(poolRejection(library.find((a) => a.tags.includes("no-audio")), tiktok, settings), "excluded-tag");
  assert.equal(poolRejection(library.find((a) => a.aspectRatioLabel === "16x9"), tiktok, settings), "aspect");
  assert.equal(poolRejection(library.find((a) => a.tags.includes("3min-plus")), tiktok, settings), "duration");
});

test("every slot fills, sectors without enough content wait, and the same song never repeats within a day per account", () => {
  const plan = run();
  assert.equal(plan.slots.filter((s) => s.status === "planned").length, 28);
  assert.deepEqual(plan.sectorsWaitingForContent, ["merch"]);
  for (const id of ["tiktok-video", "youtube-short"]) {
    const mine = plan.slots.filter((s) => s.socialAccountId === id).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    assert.equal(new Set(mine.map((s) => s.assetId)).size, mine.length, "asset reused within its 30-day cooldown");
    for (let i = 0; i < mine.length; i += 1) for (let j = i + 1; j < mine.length; j += 1) {
      const days = (new Date(mine[j].scheduledFor) - new Date(mine[i].scheduledFor)) / 86400000;
      if (days < 1) assert.notEqual(mine[i].songKey, mine[j].songKey, `song ${mine[i].songKey} repeated within a day`);
    }
  }
  assert.equal(plan.summary.find((s) => s.destination === "tiktok").exploration, 5);
  assert.ok(plan.slots.filter((s) => s.socialAccountId === "tiktok-video" && s.sector === "radio").every((s) => s.synthetic));
});

test("tag sets put reggae covers in the show sector and the two shows stay in balance", () => {
  const showSettings = resolvePlannerSettings({ planner: {
    sectors: [{ slug: "live-shows", priority: 1, share: 1, match: { tagsAny: ["stashbox-does-dylan"], tagSetsAny: [["licensed-cover", "reggae"]] } }],
    balance: [{ name: "show", sectors: ["live-shows"], weight: 12, values: {
      dylan: { tagsAny: ["stashbox-does-dylan"] }, sublime: { tagSetsAny: [["licensed-cover", "reggae"]] } } }],
    minPoolForSector: 1
  } });
  const pool = [
    ...Array.from({ length: 12 }, (_, i) => asset(["stashbox-does-dylan", `song:d${i}`])),
    ...Array.from({ length: 4 }, (_, i) => asset(["licensed-cover", "reggae", `song:r${i}`])),
    asset(["reggae", "song:not-a-cover"])
  ];
  const plan = planWeek({ assets: pool, settings: showSettings, weekStart: WEEK, timeZone: TZ, now: NOW,
    accounts: [account("instagram", "reel", 8)] });
  const shows = plan.slots.map((s) => (pool.find((a) => a.id === s.assetId).tags.includes("stashbox-does-dylan") ? "dylan" : "sublime"));
  assert.equal(shows.filter((s) => s === "dylan").length, 4);
  assert.equal(shows.filter((s) => s === "sublime").length, 4);
  assert.ok(!plan.slots.some((s) => s.songKey === "not-a-cover"));
});

test("history counts against cooldowns", () => {
  const used = library[0];
  const plan = run({ uses: [{ socialAccountId: "tiktok-video", assetId: used.id, songKey: songKeyOf(used), at: "2026-10-05T15:00:00Z" }] });
  assert.ok(!plan.slots.some((s) => s.socialAccountId === "tiktok-video" && s.assetId === used.id));
});

test("curator picks are honored when valid, replaced when they break a rule, and declines leave a visible gap", () => {
  const base = run();
  const [first, second, third] = base.slots.filter((s) => s.socialAccountId === "tiktok-video");
  const alt = first.candidates[1].assetId;
  const offPool = library.find((a) => a.aspectRatioLabel === "16x9").id;
  const plan = run({ preferences: {
    [first.slotId]: { assetId: alt, reason: "stronger hook" },
    [second.slotId]: { assetId: offPool },
    [third.slotId]: { declined: true, gap: "need crowd shots" }
  } });
  const byId = Object.fromEntries(plan.slots.map((s) => [s.slotId, s]));
  assert.equal(byId[first.slotId].assetId, alt);
  assert.equal(byId[first.slotId].selectedBy, "curator");
  assert.equal(byId[second.slotId].selectedBy, "rules");
  assert.equal(byId[second.slotId].curatorOverridden, true);
  assert.equal(byId[third.slotId].status, "gap");
  assert.match(byId[third.slotId].gap, /need crowd shots/);
});

test("guidance loads per task with hashes, within budget, and fails loudly when a file is missing", () => {
  const g = buildGuidance("select_content", { brand: "stashbox", destination: "tiktok", sectors: ["live-shows", "radio"] });
  assert.ok(g.guidance.includes("<<shared/operating-principles.md>>"));
  assert.ok(g.guidance.includes("## [tiktok] TikTok"));
  assert.ok(!g.guidance.includes("## [instagram] Instagram"));
  assert.ok(g.guidance.includes("## [live-shows]") && g.guidance.includes("## [radio]") && !g.guidance.includes("## [merch]"));
  assert.match(g.intelligenceVersion, /^[0-9a-f]{12}$/);
  // A curator week spans every active sector; copy and enrichment handle one post's sector.
  const weekSectors = ["live-shows", "radio", "streaming"];
  for (const destination of ["instagram", "facebook", "tiktok", "youtube"]) {
    buildGuidance("select_content", { brand: "stashbox", destination, sectors: weekSectors });
    for (const sector of weekSectors) {
      buildGuidance("write_copy", { brand: "stashbox", destination, sectors: [sector] });
      buildGuidance("enrich_asset", { brand: "stashbox", destination, sectors: [sector] });
    }
  }
  const root = mkdtempSync(join(tmpdir(), "intel-"));
  try {
    cpSync(join(import.meta.dirname, "..", "intelligence"), root, { recursive: true });
    rmSync(join(root, "brands", "stashbox", "brand.md"));
    assert.throws(() => buildGuidance("select_content", { brand: "stashbox", destination: "tiktok" }, root), /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sections split on bracketed headings and keep the core", () => {
  const parts = splitSections("# T\nintro\n## [a] A\nalpha\n## Plain\nplain\n## [b] B\nbeta", "^## \\[([a-z0-9-]+)\\] ");
  assert.equal(parts.sections.a, "## [a] A\nalpha");
  assert.equal(parts.sections.b, "## [b] B\nbeta");
  assert.ok(parts.core.includes("plain") && !parts.core.includes("alpha"));
});

test("curator only passes through picks from each slot's own candidates", async () => {
  const plan = run();
  const slots = plan.slots.filter((s) => s.socialAccountId === "tiktok-video");
  const invoke = async ({ system, user }) => {
    assert.ok(system.includes("Creative Selection"));
    const input = JSON.parse(user);
    return "```json\n" + JSON.stringify({ decisions: [
      { slotId: input.slots[0].slotId, status: "selected", selectedAssetId: input.slots[0].candidates[1].assetId, reason: "hook" },
      { slotId: input.slots[1].slotId, status: "selected", selectedAssetId: "not-a-candidate" }
    ], weekNotes: "flows" }) + "\n```";
  };
  const result = await curateWeek({ plan, brandSlug: "stashbox", accounts: [account("tiktok", "video", 14)], modelId: "test", invoke });
  assert.equal(result.preferences[slots[0].slotId].assetId, slots[0].candidates[1].assetId);
  assert.equal(result.preferences[slots[1].slotId], undefined);
  assert.equal(result.runs[0].accepted, 1);
  assert.equal(result.runs[0].rejected, 1);
  const failing = await curateWeek({ plan, brandSlug: "stashbox", accounts: [account("tiktok", "video", 14)], modelId: "test",
    invoke: async () => "not json" });
  assert.ok(failing.runs[0].error);
  assert.deepEqual(failing.preferences, {});
  assert.throws(() => parseDecisions("{}"), /decisions/);
});
