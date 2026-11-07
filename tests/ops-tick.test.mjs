import test from "node:test";
import assert from "node:assert/strict";
import { handleOpsTick, TICK_WORKERS, COOLDOWN_MS, resetCooldownsForTests, tokenMatches } from "../services/dev-api-lambda/ops-tick.mjs";

const json = (status, body) => ({ status, body });
const TOKEN = "deck-test-token";

function request(body, { token = TOKEN, method = "POST" } = {}) {
  return {
    requestContext: { http: { method } },
    headers: token === null ? {} : { "x-elettro-deck-key": token },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function fakeClient({ failFor = [] } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      const { FunctionName, InvocationType, Payload } = command.input;
      if (failFor.includes(FunctionName)) throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      calls.push({ FunctionName, InvocationType, payload: JSON.parse(Buffer.from(Payload).toString("utf8")) });
      return {};
    },
  };
}

const run = (event, client, extra = {}) => handleOpsTick(event, json, { client, token: TOKEN, now: () => 1_000_000, ...extra });

test("no token configured: the route stays closed", async () => {
  resetCooldownsForTests();
  const client = fakeClient();
  const res = await handleOpsTick(request({ worker: "meta" }), json, { client, token: "" });
  assert.equal(res.status, 503);
  assert.equal(client.calls.length, 0);
});

test("wrong or missing deck key is refused and nothing is invoked", async () => {
  resetCooldownsForTests();
  for (const token of ["nope", "", null]) {
    const client = fakeClient();
    const res = await run(request({ worker: "meta" }, { token }), client);
    assert.equal(res.status, 401);
    assert.equal(client.calls.length, 0);
  }
  assert.equal(tokenMatches("a", "ab"), false);
  assert.equal(tokenMatches(undefined, "ab"), false);
});

test("only POST is accepted", async () => {
  resetCooldownsForTests();
  const res = await run(request({ worker: "meta" }, { method: "GET" }), fakeClient());
  assert.equal(res.status, 405);
});

test("one worker sends exactly the scheduled tick, asynchronously", async () => {
  resetCooldownsForTests();
  const client = fakeClient();
  const res = await run(request({ worker: "Meta" }), client);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [{ worker: "meta", status: "sent" }]);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].FunctionName, "elettro-brand-os-dev-meta");
  assert.equal(client.calls[0].InvocationType, "Event");
  assert.equal(client.calls[0].payload.action, "tick");
});

test("all fires every known worker once", async () => {
  resetCooldownsForTests();
  const client = fakeClient();
  const res = await run(request({ worker: "all" }), client);
  assert.equal(res.status, 200);
  assert.equal(client.calls.length, Object.keys(TICK_WORKERS).length);
  assert.deepEqual(client.calls.map((c) => c.FunctionName).sort(), Object.values(TICK_WORKERS).sort());
});

test("unknown worker and bad JSON are 400, nothing is invoked", async () => {
  resetCooldownsForTests();
  const client = fakeClient();
  assert.equal((await run(request({ worker: "reddit" }), client)).status, 400);
  assert.equal((await run(request({}), client)).status, 400);
  assert.equal((await run(request("{not json"), client)).status, 400);
  assert.equal(client.calls.length, 0);
});

test("a second press inside the cooldown is not sent; after it, it is", async () => {
  resetCooldownsForTests();
  const client = fakeClient();
  await run(request({ worker: "x" }), client);
  const again = await run(request({ worker: "x" }), client, { now: () => 1_000_000 + 5_000 });
  assert.equal(again.body.results[0].status, "cooldown");
  assert.equal(client.calls.length, 1);
  const later = await run(request({ worker: "x" }), client, { now: () => 1_000_000 + COOLDOWN_MS + 1 });
  assert.equal(later.body.results[0].status, "sent");
  assert.equal(client.calls.length, 2);
});

test("a failed invoke is reported per worker, the rest still go, and the failed one can be retried at once", async () => {
  resetCooldownsForTests();
  const client = fakeClient({ failFor: [TICK_WORKERS.gmb] });
  const res = await run(request({ worker: "all" }), client);
  assert.equal(res.status, 200); // some were sent
  assert.equal(res.body.ok, false);
  const gmb = res.body.results.find((r) => r.worker === "gmb");
  assert.equal(gmb.status, "error");
  assert.equal(gmb.error, "AccessDeniedException");
  assert.equal(res.body.results.filter((r) => r.status === "sent").length, Object.keys(TICK_WORKERS).length - 1);
  const retry = await run(request({ worker: "gmb" }), fakeClient(), { now: () => 1_000_000 + 1 });
  assert.equal(retry.body.results[0].status, "sent");
});

test("every failing with a single worker answers 502", async () => {
  resetCooldownsForTests();
  const res = await run(request({ worker: "meta" }), fakeClient({ failFor: [TICK_WORKERS.meta] }));
  assert.equal(res.status, 502);
});
