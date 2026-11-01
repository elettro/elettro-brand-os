import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The dev-api zip is built from an explicit file list (workflow + package.json). A module that index.mjs imports but
// that is missing from the list breaks the Lambda at load time; this has happened five times (#168, #183, #187, #223, Bluesky).
const dir = new URL("../services/dev-api-lambda/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");

function reachableModules() {
  const seen = new Set(["index.mjs"]);
  const queue = ["index.mjs"];
  while (queue.length) {
    const source = read(queue.pop());
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([A-Za-z0-9_.-]+\.mjs)["']/g)) {
      if (!seen.has(match[1])) { seen.add(match[1]); queue.push(match[1]); }
    }
  }
  return [...seen];
}

// Only the words after "zip -r <zip>" count: the workflow's syntax-check list sits on the same line, and a module named only
// there used to satisfy this test while missing from the zip (gmb-planner.mjs, 2026-10-31).
const zipLine = (text) => {
  const line = text.split("\n").find((l) => l.includes("zip -r elettro-brand-os-dev-api.zip")) || "";
  const at = line.indexOf("zip -r elettro-brand-os-dev-api.zip");
  return at < 0 ? "" : line.slice(at);
};
const workflow = readFileSync(new URL("../.github/workflows/build-dev-api-lambda.yml", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("package.json", dir), "utf8");

for (const [label, text] of [["the build workflow", workflow], ["package.json build", packageJson]]) {
  test(`every module index.mjs reaches is in the zip list of ${label}`, () => {
    const files = zipLine(text).split(/\s+/);
    const missing = reachableModules().filter((name) => !files.includes(name));
    assert.deepEqual(missing, [], `missing from the zip: ${missing.join(", ")}`);
  });
}
