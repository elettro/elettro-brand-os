import test from "node:test";
import assert from "node:assert/strict";
import { needsRefresh, refreshRecord, refreshAll, pinFromPost, boardId, boardNameFor, publish } from "../services/pinterest-lambda/index.mjs";

const NOW = new Date("2026-10-21T00:00:00Z");
const days = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

test("renews only when the access token has under 7 days left and the refresh token still works", () => {
  assert.equal(needsRefresh({ refreshToken: "r", accessExpiresAt: days(20), refreshExpiresAt: days(50) }, NOW), false);
  assert.equal(needsRefresh({ refreshToken: "r", accessExpiresAt: days(5), refreshExpiresAt: days(50) }, NOW), true);
  assert.equal(needsRefresh({ refreshToken: "r", accessExpiresAt: days(-1), refreshExpiresAt: days(-1) }, NOW), false);
  assert.equal(needsRefresh({ accessExpiresAt: days(1) }, NOW), false);
});

test("a renewal stores the new access and refresh tokens with their expiry dates", async () => {
  const calls = [];
  const next = await refreshRecord({ refreshToken: "old-r", accessToken: "old-a", brands: ["elettro", "stashbox"] }, "app-secret", NOW, async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ access_token: "new-a", expires_in: 2592000, refresh_token: "new-r", refresh_token_expires_in: 5184000 }) };
  });
  assert.equal(calls[0].url, "https://api.pinterest.com/v5/oauth/token");
  assert.match(calls[0].init.headers.authorization, /^Basic /);
  assert.equal(String(calls[0].init.body), "grant_type=refresh_token&refresh_token=old-r");
  assert.equal(next.accessToken, "new-a");
  assert.equal(next.refreshToken, "new-r");
  assert.equal(next.accessExpiresAt, "2026-11-20T00:00:00.000Z");
  assert.equal(next.refreshExpiresAt, "2026-12-20T00:00:00.000Z");
  assert.deepEqual(next.brands, ["elettro", "stashbox"]);
});

test("refreshAll writes the renewed token and moves the reconnect countdown", async () => {
  const writes = [], apiCalls = [];
  const out = await refreshAll(NOW, {
    names: async () => ["elettro-brand-os-dev/pinterest/1272"],
    read: async () => ({ userId: "1272", username: "elettro", refreshToken: "r", accessExpiresAt: days(2), refreshExpiresAt: days(40) }),
    write: async (id, record) => { writes.push([id, record]); },
    refresh: async (record) => ({ ...record, accessToken: "n", accessExpiresAt: days(30), refreshExpiresAt: days(60) }),
    callApi: async (payload) => { apiCalls.push(payload); return { ok: true }; },
    appSecret: async () => "s"
  });
  assert.equal(out.ok, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(apiCalls[0], { action: "set-token-expiry", destination: "pinterest", externalAccountId: "1272", tokenExpiresAt: days(60) });
});

test("Pin text: planner title, caption as description, only https links, video by asset kind", () => {
  const pin = pinFromPost({ title: "Funky Trenchtown", caption: "Now on Stashbox Radio.\nTap the Pin.", primaryLink: "https://stashbox.com/radio/x", assetKind: "image", dropboxPath: "/a.jpg" });
  assert.deepEqual([pin.title, pin.link, pin.kind], ["Funky Trenchtown", "https://stashbox.com/radio/x", "image"]);
  const untitled = pinFromPost({ caption: "First line here\nsecond", primaryLink: "javascript:alert(1)", assetKind: "video" });
  assert.deepEqual([untitled.title, untitled.link, untitled.kind], ["First line here", null, "video"]);
  assert.throws(() => pinFromPost({}), /no title or caption/);
});

test("each brand pins to its own board, created when missing", async () => {
  assert.equal(boardNameFor("stashbox"), "Stashbox");
  assert.equal(boardNameFor("therasbox"), "Therasbox");
  const existing = async (method, path) => (method === "GET" ? { items: [{ id: "b1", name: "stashbox" }] } : assert.fail("should not create"));
  assert.equal(await boardId(existing, "stashbox"), "b1");
  const created = [];
  const empty = async (method, path, body) => (method === "GET" ? { items: [] } : (created.push(body), { id: "b2" }));
  assert.equal(await boardId(empty, "stashbox"), "b2");
  assert.deepEqual(created, [{ name: "Stashbox", privacy: "PUBLIC" }]);
});

test("an image post pins the Dropbox link to the brand board with title, description and link", async () => {
  const pins = [];
  const call = async (method, path, body) => {
    if (method === "GET" && path.startsWith("/boards")) return { items: [{ id: "b1", name: "Stashbox" }] };
    if (method === "POST" && path === "/pins") { pins.push(body); return { id: "999" }; }
    throw new Error("unexpected " + method + " " + path);
  };
  const out = await publish({ accessToken: "a" }, { brand: "stashbox", title: "T", caption: "D", primaryLink: "https://stashbox.ai", assetKind: "image", dropboxPath: "/x.jpg" },
    { call, link: async () => "https://dl.dropbox/x.jpg" });
  assert.equal(out.url, "https://www.pinterest.com/pin/999/");
  assert.deepEqual(pins[0].media_source, { source_type: "image_url", url: "https://dl.dropbox/x.jpg" });
  assert.deepEqual([pins[0].board_id, pins[0].title, pins[0].description, pins[0].link], ["b1", "T", "D", "https://stashbox.ai"]);
});

test("a video post uploads first and pins the media id with a 1 s cover frame", async () => {
  const pins = [];
  const call = async (method, path, body) => {
    if (method === "GET") return { items: [{ id: "b1", name: "Stashbox" }] };
    pins.push(body); return { id: "1000" };
  };
  await publish({ accessToken: "a" }, { brand: "stashbox", title: "T", caption: "D", assetKind: "video", dropboxPath: "/x.mp4" },
    { call, upload: async () => "m-77" });
  assert.deepEqual(pins[0].media_source, { source_type: "video_id", media_id: "m-77", cover_image_key_frame_time: 1 });
});

test("every brand's planner pins photos to pinterest:pin and 9:16 clips to pinterest:video", async () => {
  const { resolvePlannerSettings, poolRejection } = await import("../services/dev-api-lambda/planner-v2.mjs");
  // A brand whose pool is 9:16 video only (like Stashbox) still gets photos for Pins.
  const settings = resolvePlannerSettings({ planner: { pool: { kinds: ["video"], aspectRatios: ["9x16"], excludeTagsAny: [] }, placements: { "youtube:video": { aspectRatios: ["16x9"] } } } });
  const pin = { destination: "pinterest", placement: "pin" };
  assert.equal(poolRejection({ kind: "image", aspectRatioLabel: "4x5", tags: [] }, pin, settings), null);
  assert.equal(poolRejection({ kind: "image", aspectRatioLabel: "9x16", tags: [] }, pin, settings), "aspect");
  assert.equal(poolRejection({ kind: "video", aspectRatioLabel: "9x16", tags: [] }, pin, settings), "kind");
  assert.equal(poolRejection({ kind: "video", aspectRatioLabel: "9x16", tags: [], durationMs: 20000 }, { destination: "pinterest", placement: "video" }, settings), null);
  assert.deepEqual(settings.placements["youtube:video"], { aspectRatios: ["16x9"] });
});

const ROOT_P = "/1---elettro-brand-os/brands/stashbox/";
const slideList = (n, ext = "jpg") => Array.from({ length: n }, (_, i) => ({ assetId: `a${i}`, dropboxPath: `${ROOT_P}img${i}.${ext}` }));
const carouselPost = (over = {}) => ({ brand: "stashbox", placement: "carousel", title: "Gear day", caption: "Five pieces.", primaryLink: "https://stashbox.ai", slides: slideList(3), ...over });

test("a Pinterest carousel needs 2-5 safe image slides", () => {
  const pin = pinFromPost(carouselPost());
  assert.deepEqual([pin.kind, pin.slidePaths.length, pin.title, pin.link], ["carousel", 3, "Gear day", "https://stashbox.ai"]);
  assert.equal(pinFromPost(carouselPost({ slides: slideList(5, "png") })).slidePaths.length, 5);
  assert.throws(() => pinFromPost(carouselPost({ slides: slideList(1) })), /needs 2-5 images; this one has 1/);
  assert.throws(() => pinFromPost(carouselPost({ slides: slideList(6) })), /needs 2-5 images/);
  assert.throws(() => pinFromPost(carouselPost({ slides: [] })), /this one has 0/);
  assert.throws(() => pinFromPost(carouselPost({ slides: slideList(3, "mp4") })), /\.jpg or \.png/);
  assert.throws(() => pinFromPost(carouselPost({ slides: [...slideList(2), { dropboxPath: "/Personal/x.jpg" }] })), /brands/);
});

test("a carousel Pin is one Pin with a multiple_image_urls source, links on each image", async () => {
  const pins = [];
  const call = async (method, path, body) => {
    if (method === "GET" && path.startsWith("/boards")) return { items: [{ id: "b1", name: "Stashbox" }] };
    if (method === "POST" && path === "/pins") { pins.push(body); return { id: "777" }; }
    throw new Error("unexpected " + method + " " + path);
  };
  const out = await publish({ accessToken: "a" }, carouselPost(), { call, link: async (p) => "https://dl/" + p.split("/").pop() });
  assert.equal(out.url, "https://www.pinterest.com/pin/777/");
  assert.equal(pins.length, 1);
  assert.deepEqual(pins[0].media_source, { source_type: "multiple_image_urls", index: 0,
    items: [0, 1, 2].map((i) => ({ url: `https://dl/img${i}.jpg`, link: "https://stashbox.ai" })) });
  assert.deepEqual([pins[0].board_id, pins[0].title, pins[0].description], ["b1", "Gear day", "Five pieces."]);
});
