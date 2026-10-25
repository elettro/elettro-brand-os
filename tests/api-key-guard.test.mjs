import test from "node:test";
import assert from "node:assert/strict";

const KEY = "k".repeat(40);
process.env.CONNECTIONS_API_SHARED_SECRET = KEY;
const { needsKey, guardResponse } = await import("../services/dev-api-lambda/api-guard.mjs");
const { handler: syncHandler } = await import("../services/dropbox-sync-lambda/index.mjs");

const http = (method, path, headers = {}) => ({ rawPath: path, requestContext: { http: { method, path } }, headers });
const json = (statusCode, body) => ({ statusCode, body });

test("asset, brand, dashboard, content-pool reads and bulk-update need the key over HTTP", () => {
  for (const [m, p] of [["GET", "/brands"], ["GET", "/dashboard"], ["GET", "/assets"], ["GET", "/content-pool"], ["POST", "/assets/bulk-update"]]) {
    assert.equal(needsKey(http(m, p)), true, `${m} ${p}`);
  }
});

test("the public status feeds and the connect/planner routes keep their own rules", () => {
  assert.equal(needsKey(http("GET", "/status/connections")), false);
  assert.equal(needsKey(http("GET", "/status/posts")), false);
  assert.equal(needsKey(http("POST", "/planner/review")), false);
  assert.equal(needsKey(http("POST", "/connections/threads/complete")), false);
});

test("non-HTTP invokes (workers, IAM-only actions) are never blocked", () => {
  assert.equal(needsKey({ action: "claim-due-posts" }), false);
  assert.equal(guardResponse({ action: "set-token-expiry" }, json), null);
});

test("the guard rejects a missing or wrong key and accepts the right one", () => {
  assert.equal(guardResponse(http("GET", "/assets"), json).statusCode, 401);
  assert.equal(guardResponse(http("GET", "/assets", { "x-elettro-connect-key": "wrong" }), json).statusCode, 401);
  assert.equal(guardResponse(http("POST", "/assets/bulk-update", { "x-elettro-connect-key": "k".repeat(39) }), json).statusCode, 401);
  assert.equal(guardResponse(http("GET", "/assets", { "x-elettro-connect-key": KEY }), json), null);
});

test("the thumbnail Lambda refuses a keyless HTTP call before it touches Dropbox", async () => {
  const result = await syncHandler(http("GET", "/dropbox/thumbnail"));
  assert.equal(result.statusCode, 401);
  const wrong = await syncHandler(http("GET", "/dropbox/thumbnail", { "x-elettro-connect-key": "nope" }));
  assert.equal(wrong.statusCode, 401);
});

test("the thumbnail Lambda fails closed when its key is not configured", async () => {
  const saved = process.env.CONNECTIONS_API_SHARED_SECRET;
  delete process.env.CONNECTIONS_API_SHARED_SECRET;
  try {
    const result = await syncHandler(http("GET", "/dropbox/thumbnail", { "x-elettro-connect-key": KEY }));
    assert.equal(result.statusCode, 401);
  } finally { process.env.CONNECTIONS_API_SHARED_SECRET = saved; }
});
