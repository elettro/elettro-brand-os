/**
 * "Why this post?" (2026-11-08): the planner's stored reasons for a pick, in plain words, for Review and Calendar.
 *
 * Every post planner-v2 places carries `ScheduledPost.scoreBreakdown` (sector, score, breakdown, exploration, selectedBy, plannerVersion).
 * This turns that into tags, a points table and one sentence. Until analytics feed the planner (docs: "How results should shape next
 * week's posts"), every pick is "rules only" and its weights version is v1; posts planned before the version was stored count as v1 too,
 * because no other version existed.
 */

export const WHY_PARTS = {
  performance: "Results boost", freshness: "Freshness", priority: "Priority", newBatch: "New batch", balance: "Pillar balance", exploration: "Exploration",
  ready: "Ready tag", durationFit: "Length fits", songVariety: "Song variety", groupVariety: "Group variety", tiebreak: "Tie-break"
};

const round1 = (n) => Math.round(Number(n) * 10) / 10;

/** Plain-language reasons from the parts that mattered most (positive first). */
export function reasonWords(breakdown) {
  const b = breakdown || {};
  const words = [];
  if (b.performance > 0) words.push("beat this account's normal before (a boost you approved)");
  if (b.freshness >= 40) words.push("never posted on this account");
  else if (b.freshness > 0) words.push(`rested ${Math.round(b.freshness)} days past its cooldown`);
  if (b.priority >= 40) words.push("hero priority");
  else if (b.priority >= 25) words.push("high priority");
  if (b.newBatch > 0) words.push("added in the last two weeks");
  if (b.exploration > 0) words.push("trying something new (exploration slot)");
  if (b.ready > 0) words.push("marked ready");
  if (b.durationFit > 0) words.push("right length for this network");
  if (b.balance > 0) words.push("keeps the pillar's groups even");
  if (b.songVariety < 0) words.push("its song already ran this week");
  if (b.groupVariety < 0) words.push("its group already ran this week");
  return words;
}

/**
 * The why of one post, or null when the planner did not pick it (hand-written posts, holiday drafts, test posts).
 * `tags`: "rules-only" always for now, "exploring" on exploration slots.
 */
export function whyOf(scoreBreakdown) {
  const s = scoreBreakdown && typeof scoreBreakdown === "object" ? scoreBreakdown : null;
  if (!s || !s.breakdown || typeof s.breakdown !== "object") return null;
  const parts = Object.entries(s.breakdown)
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
    .map(([key, v]) => ({ key, label: WHY_PARTS[key] || key, points: round1(v) }))
    .sort((a, b) => b.points - a.points);
  const words = reasonWords(s.breakdown);
  const boosted = Number(s.breakdown.performance) > 0;
  const tags = [boosted ? "boosted" : "rules-only", ...(s.exploration ? ["exploring"] : [])];
  return {
    tags, parts, score: Number.isFinite(Number(s.score)) ? round1(s.score) : null,
    sector: s.sector || null, exploration: Boolean(s.exploration),
    selectedBy: s.selectedBy || "rules", curatorOverridden: Boolean(s.curatorOverridden),
    plannerVersion: s.plannerVersion || null, weightsVersion: s.weightsVersion || "v1",
    summary: words.length ? `${words[0].charAt(0).toUpperCase()}${words.slice(0, 3).join(", ").slice(1)}.` : "Picked by the planner's rules."
  };
}
