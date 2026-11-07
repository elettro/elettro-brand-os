// AI curator for Planner V2 (task select_content). One Bedrock call per account-week.
// The curator only expresses preferences; planWeek() re-validates every pick.
import { buildGuidance } from "./intelligence.mjs";

const MAX_OUTPUT_TOKENS = 4000;
export const CURATOR_CHUNK_SLOTS = 12; // slots per curator call; ~12 decisions fit well inside MAX_OUTPUT_TOKENS
const CURATOR_CONCURRENCY = 3; // each call is a Lambda run (AI Lambda); the AWS account allows 10 at once in total

/**
 * Model call used by the curator, the copywriter and Calendar swaps. In AWS the dev-api runs inside the VPC,
 * which has no route to Bedrock, so when AI_FUNCTION_NAME is set the call goes through the AI Lambda
 * (services/ai-lambda, outside the VPC, reached over the VPC's Lambda endpoint). Without it (local runs,
 * tests) Bedrock is called directly.
 */
export async function bedrockInvoke({ modelId, system, user }, { functionName = process.env.AI_FUNCTION_NAME, lambdaSend } = {}) {
  if (functionName) return aiLambdaInvoke({ modelId, system, user, functionName, lambdaSend });
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

let lambdaClient;
async function defaultLambdaSend(input) {
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  // Retries (with backoff) cover TooManyRequestsException when the account's Lambda concurrency is busy.
  lambdaClient = lambdaClient || new LambdaClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 4 });
  return lambdaClient.send(new InvokeCommand(input), { abortSignal: AbortSignal.timeout(58000) });
}

/** One converse-v1 call through the AI Lambda. Throws on any failure, like a direct Bedrock error. */
export async function aiLambdaInvoke({ modelId, system, user, functionName, lambdaSend = defaultLambdaSend }) {
  const result = await lambdaSend({
    FunctionName: functionName,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ action: "converse-v1", modelId, system, user, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 }))
  });
  if (result.FunctionError) throw new Error(`AI Lambda failed (${result.FunctionError})`);
  let response;
  try { response = JSON.parse(Buffer.from(result.Payload || []).toString("utf8")); } catch { throw new Error("AI Lambda returned unreadable output"); }
  if (!response || response.ok !== true) throw new Error(`AI Lambda: ${response?.error || "no answer"}`);
  return typeof response.text === "string" ? response.text : "";
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
export async function curateWeek({ plan, brandSlug, accounts, recentByAccount = {}, modelId, invoke = bedrockInvoke, intelligenceRoot, chunkSize = CURATOR_CHUNK_SLOTS, concurrency = CURATOR_CONCURRENCY }) {
  const preferences = {};
  // One call per CHUNK of an account's slots, not per whole week: a week of 40-80 slots made the answer longer than
  // MAX_OUTPUT_TOKENS, the JSON was cut off and every pick was lost (2026-11-07, Haiku 4.5). Each chunk is judged on
  // its own; planWeek() re-validates every pick, so cooldowns still hold across chunks.
  const jobs = [];
  for (const account of accounts) {
    const slots = plan.slots.filter((s) => s.socialAccountId === account.socialAccountId && s.candidates?.length);
    for (let i = 0; i < slots.length; i += chunkSize) jobs.push({ account, slots: slots.slice(i, i + chunkSize) });
  }
  const results = await mapLimit(jobs, concurrency, async ({ account, slots }) => {
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
      return { account, g, decisions: parsed.decisions.length, accepted, rejected,
        weekNotes: typeof parsed.weekNotes === "string" ? parsed.weekNotes.slice(0, 600) : null,
        notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 10).map((n) => String(n).slice(0, 300)) : [] };
    } catch (error) {
      return { account, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // One run summary per account, as before (the planner stores it on each post), plus chunk counts.
  const runs = accounts.map((account) => {
    const mine = results.filter((r) => r.account === account);
    if (!mine.length) return { socialAccountId: account.socialAccountId, destination: account.destination, skipped: "no candidates" };
    const ok = mine.filter((r) => !r.error);
    const base = { socialAccountId: account.socialAccountId, destination: account.destination, modelId, chunks: mine.length, failedChunks: mine.length - ok.length };
    if (!ok.length) return { ...base, error: mine[0].error };
    return {
      ...base, intelligenceVersion: ok[0].g.intelligenceVersion, intelligenceFiles: ok[0].g.hashes, guidanceTokens: ok[0].g.tokens,
      decisions: ok.reduce((n, r) => n + r.decisions, 0), accepted: ok.reduce((n, r) => n + r.accepted, 0), rejected: ok.reduce((n, r) => n + r.rejected, 0),
      weekNotes: ok.map((r) => r.weekNotes).filter(Boolean).join(" ").slice(0, 600) || null,
      notes: ok.flatMap((r) => r.notes).slice(0, 10),
      ...(ok.length < mine.length ? { chunkErrors: mine.filter((r) => r.error).map((r) => r.error).slice(0, 3) } : {})
    };
  });
  return { preferences, runs };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
