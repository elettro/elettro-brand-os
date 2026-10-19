import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINTS, DESTINATIONS, scoreOf, profileStatus, appOf, playbookDestinations, connectionStatusFeed, feedResponse
} from "../services/dev-api-lambda/connection-status.mjs";

const NOW = new Date("2026-10-19T12:00:00Z");
const base = { hasPlaybook: false, accountName: null, postsPerWeek: 0, readyAssets: 0, captionedPosts: 0, approvedPosts: 0,
  apiPublishCount: 0, lastApiPublishAt: null, publishingMode: "handoff", milestones: {} };

test("checkpoint weights add up to 100", () => {
  assert.equal(CHECKPOINTS.reduce((s, c) => s + c.w, 0), 100);
  assert.equal(scoreOf(Object.fromEntries(CHECKPOINTS.map((c) => [c.key, 1]))), 100);
});

test("planned-but-not-connected profile scores 50, matching today's dashboard", () => {
  const { pct, done } = profileStatus({ ...base, hasPlaybook: true, accountName: "@stashboxband", postsPerWeek: 21,
    readyAssets: 400, captionedPosts: 84, approvedPosts: 84 }, NOW);
  assert.equal(pct, 50);
  assert.equal(done.api, 0);
});

test("small content pool counts half; manual milestones fill api + oauth", () => {
  const { done, pct } = profileStatus({ ...base, hasPlaybook: true, readyAssets: 5, milestones: { api: 0.33, oauth: 1 } }, NOW);
  assert.equal(done.content, 0.5);
  assert.equal(pct, Math.round(5 + 5 + 0.33 * 15 + 15));
});

test("live needs auto mode AND an API post within 7 days", () => {
  const recent = { ...base, apiPublishCount: 3, lastApiPublishAt: "2026-10-17T09:00:00Z" };
  assert.equal(profileStatus({ ...recent, publishingMode: "handoff" }, NOW).done.live, 0);
  assert.equal(profileStatus({ ...recent, publishingMode: "auto" }, NOW).done.live, 1);
  assert.equal(profileStatus({ ...recent, publishingMode: "auto", lastApiPublishAt: "2026-10-01T00:00:00Z" }, NOW).done.live, 0);
  assert.equal(profileStatus(recent, NOW).done.test, 1);
});

test("one app per platform family", () => {
  assert.equal(appOf("instagram"), "meta");
  assert.equal(appOf("threads"), "meta");
  assert.equal(appOf("youtube"), "google");
  assert.equal(appOf("tiktok"), "tiktok");
});

test("playbook sections come from the brand's platforms.md", () => {
  const root = mkdtempSync(join(tmpdir(), "intel-"));
  mkdirSync(join(root, "brands", "stashbox"), { recursive: true });
  writeFileSync(join(root, "brands", "stashbox", "platforms.md"), "# x\n\n## [youtube] YouTube\n\n## [x] X\n");
  try {
    assert.deepEqual([...playbookDestinations("stashbox", root)], ["youtube", "x"]);
    assert.equal(playbookDestinations("nobody", root).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feed: system milestone (meta) reaches IG + FB, brand milestone only its profile; cached 60s", async () => {
  const root = mkdtempSync(join(tmpdir(), "intel-"));
  mkdirSync(join(root, "brands", "stashbox"), { recursive: true });
  writeFileSync(join(root, "brands", "stashbox", "platforms.md"), "## [instagram] IG\n## [facebook] FB\n");
  let connects = 0;
  const fake = async () => {
    connects++;
    return {
      end: async () => {},
      query: async (sql) => {
        if (sql.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", name: "Stashbox" }] };
        if (sql.includes('FROM "SocialAccount"')) return { rows: [{ id: "a1", destination: "instagram", accountName: "@stashboxmusic",
          publishingMode: "handoff", postsPerWeek: 21, captionedPosts: 10, approvedPosts: 10, apiPublishCount: 0, lastApiPublishAt: null,
          tokenExpiresAt: new Date("2026-12-18T12:00:00Z") }] };
        if (sql.includes('FROM "Asset"')) return { rows: [{ destination: "instagram", n: 120 }, { destination: "facebook", n: 120 }] };
        if (sql.includes('FROM "PlatformMilestone"')) return { rows: [
          { brandId: null, destination: "meta", key: "api", value: 0.33, note: "Meta app created" },
          { brandId: "b1", destination: "facebook", key: "oauth", value: 1, note: null }] };
        return { rows: [] };
      }
    };
  };
  try {
    const t = Date.parse("2026-10-19T12:00:00Z");
    const feed = await connectionStatusFeed(fake, { root, now: t });
    const p = Object.fromEntries(feed.brands[0].profiles.map((x) => [x.destination, x]));
    assert.equal(feed.brands[0].profiles.length, DESTINATIONS.length);
    assert.equal(p.instagram.done.api, 0.33);
    assert.equal(p.facebook.done.api, 0.33);
    assert.equal(p.tiktok.done.api, 0);
    assert.equal(p.facebook.done.oauth, 1);
    assert.equal(p.instagram.done.oauth, 0);
    assert.equal(p.instagram.pct, 55);
    assert.equal(p.instagram.tokenExpiresAt, "2026-12-18T12:00:00.000Z");
    assert.equal(p.facebook.tokenExpiresAt, null);
    await connectionStatusFeed(fake, { root, now: t + 30_000 });
    assert.equal(connects, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a linked account counts as oauth connected and half api credit", () => {
  const { done } = profileStatus({ ...base, connected: true, milestones: {} }, NOW);
  assert.equal(done.oauth, 1);
  assert.equal(done.api, 0.5);
  assert.equal(profileStatus({ ...base, connected: true, milestones: { api: 1 } }, NOW).done.api, 1);
});

test("feed response is public-readable JSON", () => {
  const r = feedResponse(200, { ok: true });
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.match(r.headers["cache-control"], /max-age=60/);
});
