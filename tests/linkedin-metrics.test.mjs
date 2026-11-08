import test from "node:test";
import assert from "node:assert/strict";
import { listParamFor, statisticsPath, collectForPage, metricsFromStatistics } from "../services/linkedin-lambda/metrics.mjs";
import { collectMetrics } from "../services/linkedin-lambda/index.mjs";
import { METRIC_DESTINATIONS } from "../services/dev-api-lambda/post-metrics.mjs";

test("LinkedIn is a collected network", () => {
  assert.ok(METRIC_DESTINATIONS.includes("linkedin"));
});

test("share and ugcPost urns go in separate lists, statistics map to views, reach and clicks", async () => {
  const param = listParamFor(["urn:li:share:1", "urn:li:ugcPost:2", "urn:li:share:3", "junk"]);
  assert.equal(param, "shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A3)&ugcPosts=List(urn%3Ali%3AugcPost%3A2)");
  assert.match(statisticsPath("urn:li:organization:9", ["urn:li:share:1"]), /organizationalEntity=urn%3Ali%3Aorganization%3A9&shares=List/);
  assert.deepEqual(metricsFromStatistics({ impressionCount: 100, uniqueImpressionsCounter: 80, clickCount: 5, likeCount: 4, commentCount: 1, shareCount: 2 }),
    { views: 100, reach: 80, likes: 4, comments: 1, shares: 2, linkClicks: 5, saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null });
  const asked = [];
  const call = async (path) => (asked.push(path), { elements: [
    { share: "urn:li:share:1", totalShareStatistics: { impressionCount: 7, likeCount: 1 } },
    { ugcPost: "urn:li:ugcPost:2", totalShareStatistics: { impressionCount: 9 } }] });
  const items = [
    { ledgerId: "a", postId: "urn:li:share:1", buckets: ["1h", "24h"] },
    { ledgerId: "b", postId: "urn:li:ugcPost:2", buckets: ["1h"] },
    { ledgerId: "c", postId: "urn:li:share:99", buckets: ["1h"] },
    { ledgerId: "d", postId: "not-a-urn", buckets: ["1h"] }
  ];
  const { snapshots, missing } = await collectForPage("urn:li:organization:9", items, call);
  assert.equal(asked.length, 1);
  assert.deepEqual(missing, ["urn:li:share:99"]);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].source, "linkedin-statistics");
  assert.equal(snapshots[2].metrics.views, 9);
  await assert.rejects(() => collectForPage("urn:li:organization:9", items.slice(0, 1), async () => { throw new Error("LinkedIn share statistics failed: 403"); }), /403/);
});

test("the worker groups by page, saves, survives a page that fails, and a dry run saves nothing", async () => {
  const recorded = [];
  const due = [
    { ledgerId: "a", postId: "urn:li:share:1", channelId: "urn:li:organization:1", buckets: ["1h"] },
    { ledgerId: "b", postId: "urn:li:share:2", channelId: "urn:li:organization:2", buckets: ["1h"] }
  ];
  const callApi = async (p) => p.action === "list-post-metrics-due-20261107" ? { ok: true, due } : (recorded.push(...p.items), { ok: true, saved: p.items.length });
  const find = async (org) => { if (org.endsWith(":2")) throw new Error("The LinkedIn login has expired"); return { accessToken: "t" }; };
  const call = async () => ({ elements: [{ share: "urn:li:share:1", totalShareStatistics: { impressionCount: 3 } }] });
  const dry = await collectMetrics({ dryRun: true }, { callApi, find, call });
  assert.equal(recorded.length, 0);
  assert.equal(dry.samples.length, 1);
  const done = await collectMetrics({}, { callApi, find, call });
  assert.equal(done.saved, 1);
  assert.equal(done.failures.length, 1);
});
