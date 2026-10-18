// Offline dry run of Planner V2 against an asset snapshot (no database, no writes).
// Usage: node scripts/simulate-week.mjs <assets.json> <planner.json> [weekStart YYYY-MM-DD] [--radio songs.json] [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { planWeek, resolvePlannerSettings, nextWeekStart, ymdInTimeZone, songKeyOf } from "../planner-v2.mjs";
import { buildSongFacts } from "../song-facts.mjs";
import { writeWeekCopy } from "../copywriter.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const radioPath = flag("--radio");
const jsonOut = flag("--json");
const [assetsPath, seedPath, weekArg] = args;
if (!assetsPath || !seedPath) {
  console.error("Usage: node scripts/simulate-week.mjs <assets.json> <planner.json> [weekStart] [--radio songs.json] [--json out.json]");
  process.exit(1);
}
const read = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
const raw = read(assetsPath);
const assets = (Array.isArray(raw) ? raw : raw.assets).filter((a) => a.approvalStatus === "approved" && !a.retiredAt);
const seed = read(seedPath);
const timeZone = "America/New_York";
const settings = resolvePlannerSettings({ planner: seed.settings });
const accounts = seed.accounts.map((a) => ({ ...a, socialAccountId: `${a.destination}-${a.placement}`, timezone: timeZone }));
const weekStart = weekArg && /^\d{4}-\d{2}-\d{2}$/.test(weekArg) ? weekArg : nextWeekStart(ymdInTimeZone(new Date(), timeZone));
const catalog = radioPath ? (read(radioPath).songs || []) : [];
const songFacts = buildSongFacts(assets.map(songKeyOf).filter(Boolean), catalog, {
  radioBaseUrl: settings.sources?.radioBaseUrl, overrides: settings.sources?.songOverrides || {}
});

const plan = planWeek({ assets, accounts, settings, weekStart, timeZone, songFacts });
const copies = await writeWeekCopy({ slots: plan.slots.filter((s) => s.status === "planned"),
  assetsById: new Map(assets.map((a) => [a.id, a])), songFacts, links: settings.links || {}, brandSlug: seed.brand || "stashbox",
  promotionalMaxShare: settings.promotionalMaxShare || {} });
const copyBySlot = new Map(copies.map((c) => [c.slotId, c.copy]));
for (const s of plan.slots) s.copy = copyBySlot.get(s.slotId) || null;

console.log(`Week ${plan.weekStart} – ${plan.weekEnd} · ${assets.length} approved assets · ${catalog.length} radio songs`);
const slugs = Object.values(songFacts);
console.log(`Songs with a radio page: ${slugs.filter((f) => f.inCatalog).length}/${slugs.length}; with a streaming link: ${slugs.filter((f) => f.spotifyUrl || f.appleMusicUrl).length}`);
for (const s of plan.summary) {
  console.log(`${s.destination} ${s.placement}: pool ${s.poolSize}, ${s.planned}/${s.slots} planned, ${s.distinctSongs} songs, ` +
    `${s.exploration} exploration, ${s.synthetic} AI-flagged · sectors ${JSON.stringify(s.bySector)}`);
}
console.log(`Sectors waiting for content: ${plan.sectorsWaitingForContent.join(", ") || "none"}`);
console.log(`Gaps/fallbacks: ${plan.gaps.length}; copy problems: ${copies.filter((c) => c.copy.problems?.length || c.copy.status !== "ready").length}`);
for (const ymd of [...new Set(plan.slots.map((s) => s.ymd))].slice(0, 1)) {
  console.log(`\n== ${ymd}`);
  for (const s of plan.slots.filter((x) => x.ymd === ymd)) {
    console.log(`  ${s.localTime} ${s.destination.padEnd(9)} ${String(s.sector).padEnd(10)}${s.exploration ? "*" : " "} ${s.status === "gap" ? "GAP " + s.gap : s.filename}`);
    if (s.copy) console.log(`      ${(s.copy.title ? s.copy.title + " | " : "") + String(s.copy.caption || s.copy.description || "").replace(/\n/g, " / ")}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...plan, songFacts }, null, 2));
