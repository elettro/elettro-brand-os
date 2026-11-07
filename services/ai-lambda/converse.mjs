// Bedrock relay for the dev-api (2026-11-07). The dev-api runs inside the VPC, which has no route to
// Bedrock (no NAT, no bedrock-runtime endpoint), so it hands its model calls to this Lambda, which runs
// outside the VPC. IAM-only: no HTTP route, no Function URL. One action, `converse-v1`, text in, text out.

export const DEFAULT_ALLOWED_MODELS = ["us.anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5"];
export const LIMITS = { systemChars: 400_000, userChars: 800_000, maxTokens: 8000, timeoutMs: 50_000 };

export function allowedModels(env = process.env) {
  const list = String(env.AI_ALLOWED_MODEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(list.length ? list : DEFAULT_ALLOWED_MODELS);
}

/** Validate a converse-v1 request. Returns { ok:true, request } or { ok:false, error }. */
export function parseRequest(event, env = process.env) {
  if (!event || event.action !== "converse-v1") return { ok: false, error: "Unknown action" };
  const { modelId, system, user } = event;
  if (typeof modelId !== "string" || !allowedModels(env).has(modelId)) return { ok: false, error: "Model not allowed" };
  if (typeof system !== "string" || system.length > LIMITS.systemChars) return { ok: false, error: "Invalid system prompt" };
  if (typeof user !== "string" || !user.trim() || user.length > LIMITS.userChars) return { ok: false, error: "Invalid user prompt" };
  const maxTokens = event.maxTokens === undefined ? 4000 : event.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > LIMITS.maxTokens) return { ok: false, error: "Invalid maxTokens" };
  const temperature = event.temperature === undefined ? 0.3 : event.temperature;
  if (typeof temperature !== "number" || temperature < 0 || temperature > 1) return { ok: false, error: "Invalid temperature" };
  return { ok: true, request: { modelId, system, user, maxTokens, temperature } };
}

export async function converse(request, send) {
  const result = await send({
    modelId: request.modelId,
    system: request.system ? [{ text: request.system }] : undefined,
    messages: [{ role: "user", content: [{ text: request.user }] }],
    inferenceConfig: { maxTokens: request.maxTokens, temperature: request.temperature }
  });
  const text = result.output?.message?.content?.flatMap((p) => (p.text ? [p.text] : [])).join("\n") || "";
  return { text, stopReason: result.stopReason || null, usage: result.usage || null };
}

/** Never throws: errors come back as { ok:false, error } so the caller can fall back to rules-only. */
export async function handleEvent(event, send, env = process.env) {
  const parsed = parseRequest(event, env);
  if (!parsed.ok) return parsed;
  const started = Date.now();
  try {
    const out = await converse(parsed.request, send);
    console.info("[ai] converse ok", JSON.stringify({ modelId: parsed.request.modelId, ms: Date.now() - started, usage: out.usage, stopReason: out.stopReason }));
    return { ok: true, ...out };
  } catch (error) {
    console.error("[ai] converse failed", parsed.request.modelId, error?.name, error?.message);
    return { ok: false, error: `${error?.name || "Error"}: ${error?.message || "Bedrock call failed"}` };
  }
}
