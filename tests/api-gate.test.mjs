import test from "node:test";
import assert from "node:assert/strict";
import { gateHttp, brandFilter, isHttpEvent } from "../services/dev-api-lambda/api-gate.mjs";

const json = (statusCode, body) => ({ statusCode, body });
const http = (path, headers = {}, method = "GET") => ({ rawPath: path, headers, requestContext: { http: { method, path } } });
process.env.CONNECTIONS_API_SHARED_SECRET = "s3cret-key";

test("status feeds stay public", () => {
  assert.equal(gateHttp(http("/status/connections"), "/status/connections", json), null);
  assert.equal(gateHttp(http("/status/posts"), "/status/posts", json), null);
});

test("data and write routes need the connect key", () => {
  for (const p of ["/assets", "/content-pool", "/brands", "/dashboard", "/assets/bulk-update", "/assets/upload/presign", "/dropbox/thumbnail", "/planner/run", "/dropbox/ingest-page"]) {
    assert.equal(gateHttp(http(p), p, json).statusCode, 401, p);
    assert.equal(gateHttp(http(p, { "x-elettro-connect-key": "wrong-key!" }), p, json).statusCode, 401, p);
    assert.equal(gateHttp(http(p, { "x-elettro-connect-key": "s3cret-key" }, "POST"), p, json), null, p);
  }
});

test("a public path does not open other methods", () => {
  assert.equal(gateHttp(http("/status/connections", {}, "POST"), "/status/connections", json).statusCode, 401);
});

test("no configured secret means nothing passes", () => {
  const saved = process.env.CONNECTIONS_API_SHARED_SECRET;
  delete process.env.CONNECTIONS_API_SHARED_SECRET;
  assert.equal(gateHttp(http("/assets", { "x-elettro-connect-key": "" }), "/assets", json).statusCode, 401);
  process.env.CONNECTIONS_API_SHARED_SECRET = saved;
});

test("IAM invokes are not HTTP and skip the gate", () => {
  const iam = { action: "claim-due-posts" };
  assert.equal(isHttpEvent(iam), false);
  assert.equal(gateHttp(iam, "", json), null);
});

test("brand filter parses a clean slug list", () => {
  assert.equal(brandFilter({}), null);
  assert.deepEqual(brandFilter({ queryStringParameters: { brands: "solarmeister, Neckermann-Strom" } }), ["solarmeister", "neckermann-strom"]);
  assert.deepEqual(brandFilter({ queryStringParameters: { brands: "x'; drop--" } }), []);
});
