// Offline dry run of Planner V2 against an asset snapshot (no database, no writes).
// Usage: node scripts/simulate-week.mjs <assets.json> <planner.json> [weekStart YYYY-MM-DD] [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { planWeek, resolvePlannerSettings, nextWeekStart, ymdInTimeZone } from "../planner-v2.mjs";

const [assetsPath, seedPath, weekArg, ...rest] = process.argv.slice(2);
if (!assetsPath || !seedPath) {
  console.error("Usage: node scripts/simulate-week.mjs <assets.json> <planner.json> [weekStart] [--json out.json]");
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

const plan = planWeek({ assets, accounts, settings, weekStart, timeZone });

console.log(`Week ${plan.weekStart} – ${plan.weekEnd} · ${assets.length} approved assets considered`);
for (const s of plan.summary) {
  console.log(`\n${s.destination} ${s.placement}: pool ${s.poolSize}, ${s.planned}/${s.slots} planned, ${s.distinctSongs} songs, ` +
    `${s.exploration} exploration, ${s.synthetic} AI-flagged · sectors ${JSON.stringify(s.bySector)}`);
}
console.log(`\nSectors waiting for content: ${plan.sectorsWaitingForContent.join(", ") || "none"}`);
console.log(`Gaps/fallbacks: ${plan.gaps.length}`);
for (const ymd of [...new Set(plan.slots.map((s) => s.ymd))]) {
  console.log(`\n== ${ymd}`);
  for (const s of plan.slots.filter((x) => x.ymd === ymd)) {
    console.log(`  ${s.localTime} ${s.destination.padEnd(9)} ${String(s.sector).padEnd(10)}${s.exploration ? "*" : " "} ` +
      `${s.status === "gap" ? "GAP " + s.gap : s.filename}`);
  }
}
const jsonIndex = rest.indexOf("--json");
if (jsonIndex >= 0 && rest[jsonIndex + 1]) writeFileSync(rest[jsonIndex + 1], JSON.stringify(plan, null, 2));
