import test from "node:test";
import assert from "node:assert/strict";
import { handleEvent, parseRequest, allowedModels, DEFAULT_ALLOWED_MODELS } from "../services/ai-lambda/converse.mjs";
import { bedrockInvoke, aiLambdaInvoke } from "../services/dev-api-lambda/curator.mjs";

const HAIKU = "us.anthropic.claude-haiku-5-5";
const reply = (text) => async () => ({ output: { message: { content: [{ text }] } }, stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1 } });

test("ai-lambda: default allow list is Haiku 5.5 inference profiles only", () => {
  assert.deepEqual([...allowedModels({})], DEFAULT_ALLOWED_MODELS);
  assert.deepEqual([...allowedModels({ AI_ALLOWED_MODEL_IDS: " a , b " })], ["a", "b"]);
});

test("ai-lambda: rejects unknown action, model, bad prompts and limits", () => {
  const ok = { action: "converse-v1", modelId: HAIKU, system: "s", user: "u" };
  assert.equal(parseRequest({ ...ok, action: "tick" }, {}).error, "Unknown action");
  assert.equal(parseRequest({ ...ok, modelId: "anthropic.claude-opus-5-5" }, {}).error, "Model not allowed");
  assert.equal(parseRequest({ ...ok, user: "  " }, {}).error, "Invalid user prompt");
  assert.equal(parseRequest({ ...ok, system: 5 }, {}).error, "Invalid system prompt");
  assert.equal(parseRequest({ ...ok, maxTokens: 99999 }, {}).error, "Invalid maxTokens");
  assert.equal(parseRequest({ ...ok, temperature: 2 }, {}).error, "Invalid temperature");
  assert.deepEqual(parseRequest(ok, {}).request, { modelId: HAIKU, system: "s", user: "u", maxTokens: 4000, temperature: 0.3 });
  assert.equal(parseRequest(null, {}).ok, false);
});

test("ai-lambda: returns model text and sends a Converse request", async () => {
  let sent;
  const out = await handleEvent({ action: "converse-v1", modelId: HAIKU, system: "sys", user: "hi", maxTokens: 10 },
    async (input) => { sent = input; return reply("OK")(); }, {});
  assert.equal(out.ok, true);
  assert.equal(out.text, "OK");
  assert.equal(sent.modelId, HAIKU);
  assert.deepEqual(sent.system, [{ text: "sys" }]);
  assert.deepEqual(sent.messages, [{ role: "user", content: [{ text: "hi" }] }]);
  assert.deepEqual(sent.inferenceConfig, { maxTokens: 10, temperature: 0.3 });
});

test("ai-lambda: a Bedrock error comes back as ok:false, never a throw", async () => {
  const out = await handleEvent({ action: "converse-v1", modelId: HAIKU, system: "", user: "hi" },
    async () => { const e = new Error("denied"); e.name = "AccessDeniedException"; throw e; }, {});
  assert.deepEqual(out, { ok: false, error: "AccessDeniedException: denied" });
});

test("dev-api: bedrockInvoke goes through the AI Lambda when AI_FUNCTION_NAME is set", async () => {
  let call;
  const lambdaSend = async (input) => { call = input; return { Payload: Buffer.from(JSON.stringify({ ok: true, text: "{\"decisions\":[]}" })) }; };
  const text = await bedrockInvoke({ modelId: HAIKU, system: "g", user: "u" }, { functionName: "elettro-brand-os-dev-ai", lambdaSend });
  assert.equal(text, "{\"decisions\":[]}");
  assert.equal(call.FunctionName, "elettro-brand-os-dev-ai");
  assert.equal(call.InvocationType, "RequestResponse");
  const payload = JSON.parse(Buffer.from(call.Payload).toString("utf8"));
  assert.equal(payload.action, "converse-v1");
  assert.equal(payload.modelId, HAIKU);
  assert.equal(payload.user, "u");
});

test("dev-api: AI Lambda failures throw so the planner falls back to rules", async () => {
  const run = (result) => aiLambdaInvoke({ modelId: HAIKU, system: "", user: "u", functionName: "f", lambdaSend: async () => result });
  await assert.rejects(run({ FunctionError: "Unhandled", Payload: Buffer.from("{}") }), /AI Lambda failed/);
  await assert.rejects(run({ Payload: Buffer.from(JSON.stringify({ ok: false, error: "Model not allowed" })) }), /Model not allowed/);
  await assert.rejects(run({ Payload: Buffer.from("not json") }), /unreadable/);
});

test("ai-lambda round trip: dev-api payload is accepted by the AI Lambda", async () => {
  const lambdaSend = async (input) => {
    const out = await handleEvent(JSON.parse(Buffer.from(input.Payload).toString("utf8")), reply("hello"), {});
    return { Payload: Buffer.from(JSON.stringify(out)) };
  };
  assert.equal(await bedrockInvoke({ modelId: HAIKU, system: "s", user: "u" }, { functionName: "f", lambdaSend }), "hello");
});
