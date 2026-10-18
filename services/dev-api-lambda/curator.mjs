// AI curator for Planner V2 (task select_content). One Bedrock call per account-week.
// The curator only expresses preferences; planWeek() re-validates every pick.
import { buildGuidance } from "./intelligence.mjs";

const MAX_OUTPUT_TOKENS = 4000;

export async function bedrockInvoke({ modelId, system, user }) {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 2 });
  const result = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages: [{ role: "user", content: [{ text: user }] }],
    inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 }
  }), { abortSignal: AbortSignal.timeout(55000) });
  return result.output?.message?.content?.flatMap((p) => (p.text ? [p.text] : [])).join("\n") || "";
}

export function parseDecisions(text) {
  const body = String(text).replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const parsed = JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
  if (!parsed || !Array.isArray(parsed.decisions)) throw new Error("Curator response has no decisions array");
  return parsed;
}

/** Live input for one account-week: slots in order with their candidates, plus recent posts. */
export function curatorInput({ brandSlug, account, weekStart, weekEnd, slots, recent }) {
  return {
    brand: brandSlug,
    destination: account.destination,
    placement: account.placement,
    week: { start: weekStart, end: weekEnd },
    recentPosts: recent.slice(0, 10),
    slots: slots.map((s) => ({
      slotId: s.slotId,
      date: s.ymd,
      time: s.localTime,
      sector: s.sector,
      exploration: s.exploration,
      candidates: s.candidates.map((c) => ({
        assetId: c.assetId,
        filename: c.filename,
        song: c.songKey,
        contentGroup: c.contentGroup,
        title: c.title,
        notes: c.notes,
        tags: c.tags,
        aiGenerated: c.synthetic,
        score: c.score,
        breakdown: c.breakdown
      }))
    }))
  };
}

/**
 * Ask the curator for preferences on a rules-only plan.
 * Returns { preferences: {slotId: {assetId?, declined?, reason, gap}}, runs: [...] }.
 * Failures never block planning: that account keeps the rules picks and the error is reported.
 */
export async function curateWeek({ plan, brandSlug, accounts, recentByAccount = {}, modelId, invoke = bedrockInvoke, intelligenceRoot }) {
  const preferences = {};
  const runs = await Promise.all(accounts.map(async (account) => {
    const slots = plan.slots.filter((s) => s.socialAccountId === account.socialAccountId && s.candidates?.length);
    if (!slots.length) return { socialAccountId: account.socialAccountId, destination: account.destination, skipped: "no candidates" };
    const sectors = [...new Set(slots.map((s) => s.sector).filter(Boolean))];
    try {
      const g = buildGuidance("select_content", { brand: brandSlug, destination: account.destination, sectors }, intelligenceRoot);
      const user = JSON.stringify(curatorInput({
        brandSlug, account, weekStart: plan.weekStart, weekEnd: plan.weekEnd, slots,
        recent: recentByAccount[account.socialAccountId] || []
      }));
      const text = await invoke({ modelId, system: g.guidance, user });
      const parsed = parseDecisions(text);
      const known = new Map(slots.map((s) => [s.slotId, new Set(s.candidates.map((c) => c.assetId))]));
      let accepted = 0;
      let rejected = 0;
      for (const d of parsed.decisions) {
        const ids = known.get(d?.slotId);
        if (!ids) { rejected += 1; continue; }
        if (d.status === "declined") {
          preferences[d.slotId] = { declined: true, reason: d.reason || null, gap: d.gap || null };
          accepted += 1;
        } else if (ids.has(d.selectedAssetId)) {
          preferences[d.slotId] = { assetId: d.selectedAssetId, reason: d.reason || null, decidingFactor: d.decidingFactor || null };
          accepted += 1;
        } else {
          rejected += 1;
        }
      }
      return {
        socialAccountId: account.socialAccountId, destination: account.destination, modelId,
        intelligenceVersion: g.intelligenceVersion, intelligenceFiles: g.hashes, guidanceTokens: g.tokens,
        decisions: parsed.decisions.length, accepted, rejected,
        weekNotes: typeof parsed.weekNotes === "string" ? parsed.weekNotes.slice(0, 600) : null,
        notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 10).map((n) => String(n).slice(0, 300)) : []
      };
    } catch (error) {
      return { socialAccountId: account.socialAccountId, destination: account.destination, modelId,
        error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { preferences, runs };
}
