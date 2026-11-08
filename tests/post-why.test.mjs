import test from "node:test";
import assert from "node:assert/strict";
import { whyOf, reasonWords } from "../services/dev-api-lambda/post-why.mjs";

test("a planner pick becomes tags, sorted points and one plain sentence", () => {
  const why = whyOf({ sector: "live-shows", score: 87.456, exploration: true, selectedBy: "rules", plannerVersion: "planner-v2.0",
    breakdown: { freshness: 40, priority: 25, newBatch: 0, songVariety: -10, exploration: 35, tiebreak: 1.234 } });
  assert.deepEqual(why.tags, ["rules-only", "exploring"]);
  assert.deepEqual(why.parts.map((p) => [p.key, p.points]), [["freshness", 40], ["exploration", 35], ["priority", 25], ["tiebreak", 1.2], ["songVariety", -10]]);
  assert.equal(why.score, 87.5);
  assert.equal(why.weightsVersion, "v1");
  assert.equal(why.summary, "Never posted on this account, high priority, trying something new (exploration slot).");
});

test("posts the planner did not pick have no why; a stored weights version wins", () => {
  assert.equal(whyOf(null), null);
  assert.equal(whyOf({ custom: { kind: "text" } }), null);
  assert.equal(whyOf({ breakdown: {}, weightsVersion: "v3" }).weightsVersion, "v3");
  assert.equal(whyOf({ breakdown: {} }).summary, "Picked by the planner's rules.");
  assert.deepEqual(reasonWords({ freshness: 12.4, priority: 40 }), ["rested 12 days past its cooldown", "hero priority"]);
});
