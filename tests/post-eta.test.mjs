import test from "node:test";
import assert from "node:assert/strict";
import { countdown, TICK_MS } from "../apps/web/lib/post-eta.ts";

const now = Date.UTC(2026, 10, 4, 16, 30, 0);
const min = 60000;
test("countdown wording", () => {
  assert.equal(countdown(now + 30000, now), "in under a minute");
  assert.equal(countdown(now + 3 * min, now), "in 3 min");
  assert.equal(countdown(now + (2 * 60 + 5) * min, now), "in 2 h 5 min");
  assert.equal(countdown(now + (4 * 24 * 60 + 12 * 60) * min, now), "in 4 days 12 h");
  assert.equal(countdown(now + (24 * 60 + 60) * min, now), "in 1 day 1 h");
});
test("past or exact time returns null", () => {
  assert.equal(countdown(now, now), null);
  assert.equal(countdown(now - min, now), null);
});
test("a post goes out at the latest one tick after its time", () => assert.equal(TICK_MS, 15 * min));
