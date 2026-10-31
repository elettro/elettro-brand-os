import test from "node:test";
import assert from "node:assert/strict";
import { buildSlots, slotsToPlan, spreadMinutes, separateSlots, timeProfileOf, goodMinute } from "../services/dev-api-lambda/planner-v2.mjs";

const TZ = "America/New_York";
const WEEK = "2026-11-02"; // a Monday
const mk = (id, destination, placement, postsPerWeek, extra = {}) => ({
  socialAccountId: id, destination, placement, accountName: id, postsPerWeek, preferredDays: [], timezone: TZ, publishingMode: "approval", ...extra
});
const mins = (slots) => slots.map((s) => Number(s.localTime.slice(0, 2)) * 60 + Number(s.localTime.slice(3))).sort((a, b) => a - b);
const gaps = (m) => m.slice(1).map((x, i) => x - m[i]);

test("posts never sit on the quarter hour (:00 :15 :30 :45)", () => {
  const slots = [mk("a", "tiktok", "video", 70), mk("b", "instagram", "story", 98), mk("c", "bluesky", "post", 35)].flatMap((a) => buildSlots(a, WEEK, TZ));
  assert.ok(slots.length > 150);
  assert.ok(slots.every((s) => goodMinute(Number(s.localTime.slice(3)))), "no quarter-hour minute");
});

test("a format's posts for a day are equally spaced across the network's window", () => {
  const m = spreadMinutes(6, timeProfileOf("tiktok"), "seed"); // 09:00-21:00
  assert.equal(m.length, 6);
  assert.ok(m[0] >= 9 * 60 && m[5] <= 21 * 60);
  for (const g of gaps(m)) assert.ok(Math.abs(g - 120) <= 14, `gap ${g} is close to 120 minutes`);
});

test("adding a post re-spaces all of them: more posts, smaller gaps, and fewer posts, wider gaps", () => {
  const avg = (n) => { const m = spreadMinutes(n, timeProfileOf("pinterest"), "s"); return (m[n - 1] - m[0]) / (n - 1); };
  assert.ok(avg(8) < avg(4) && avg(4) < avg(2));
});

test("the same inputs always give the same times, so a replan does not shuffle them", () => {
  assert.deepEqual(spreadMinutes(5, timeProfileOf("pinterest"), "x"), spreadMinutes(5, timeProfileOf("pinterest"), "x"));
  assert.notDeepEqual(spreadMinutes(5, timeProfileOf("pinterest"), "x"), spreadMinutes(5, timeProfileOf("pinterest"), "y"));
});

test("LinkedIn posts only on weekdays, 08:00 to 12:00", () => {
  const slots = buildSlots(mk("li", "linkedin", "post", 5), WEEK, TZ);
  assert.equal(slots.length, 5);
  assert.deepEqual([...new Set(slots.map((s) => s.ymd))], ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.ok(mins(slots).every((m) => m >= 8 * 60 && m < 12 * 60));
});

test("Bluesky and Mastodon run 08:00-20:00 with about 70% of a day's posts between 09:00 and 17:00", () => {
  for (const destination of ["bluesky", "mastodon"]) {
    const day = buildSlots(mk("x", destination, "post", 70), WEEK, TZ).filter((s) => s.ymd === WEEK); // 10 a day
    const m = mins(day);
    assert.equal(m.length, 10);
    assert.ok(m[0] >= 8 * 60 && m[9] < 20 * 60);
    assert.equal(m.filter((x) => x >= 9 * 60 && x < 17 * 60).length, 7);
  }
});

test("a brand can override a network's window", () => {
  const profile = timeProfileOf("tiktok", { start: "12:00", end: "14:00" });
  const m = mins(buildSlots(mk("t", "tiktok", "video", 7), WEEK, TZ, profile));
  assert.ok(m.every((x) => x >= 12 * 60 && x < 14 * 60));
});

test("two formats of one network are pulled at least 7 minutes apart, and no two posts of a brand share a minute", () => {
  // Two formats that would land on the very same minute, and another network doing the same.
  const a = mk("ig", "instagram", "reel", 7), b = mk("ig", "instagram", "story", 7), c = mk("tt", "tiktok", "video", 7);
  const lists = [a, b, c].map((x) => buildSlots(x, WEEK, TZ));
  for (const s of lists[1]) { const twin = lists[0].find((o) => o.ymd === s.ymd); s.localTime = twin.localTime; s.slotId = `ig:${s.ymd}:${s.localTime}`; s.scheduledFor = twin.scheduledFor; }
  for (const s of lists[2]) { const twin = lists[0].find((o) => o.ymd === s.ymd); s.localTime = twin.localTime; s.slotId = `tt:${s.ymd}:${s.localTime}`; s.scheduledFor = twin.scheduledFor; }
  separateSlots(lists, () => TZ);
  for (const ymd of new Set(lists.flat().map((s) => s.ymd))) {
    const day = lists.flat().filter((s) => s.ymd === ymd);
    const m = (s) => Number(s.localTime.slice(0, 2)) * 60 + Number(s.localTime.slice(3));
    const ig = day.filter((s) => s.socialAccountId === "ig");
    assert.ok(Math.abs(m(ig[0]) - m(ig[1])) >= 7, "reel and story of one network are 7+ minutes apart");
    assert.equal(new Set(day.map(m)).size, day.length, "every post has its own minute");
    assert.ok(day.every((s) => goodMinute(Number(s.localTime.slice(3)))));
    assert.ok(day.every((s) => s.scheduledFor === new Date(s.scheduledFor).toISOString()));
  }
});

test("a replan late in the day tops up only the rest of today inside the window", () => {
  const now = new Date("2026-11-03T18:00:00Z"); // 13:00 EST on the Tuesday
  const slots = slotsToPlan(mk("tt", "tiktok", "video", 35), WEEK, TZ, now, 2);
  const today = slots.filter((s) => s.ymd === "2026-11-03");
  assert.equal(today.length, 3);
  assert.ok(mins(today)[0] >= 13 * 60 + 20 && mins(today)[2] < 21 * 60);
});

test("minutes spread around the whole hour: none on :00 :15 :30 :45, and not piled near the top of the hour", () => {
  const accounts = [mk("a", "tiktok", "video", 98), mk("b", "instagram", "story", 98), mk("c", "bluesky", "post", 98), mk("d", "mastodon", "video", 70), mk("e", "linkedin", "post", 5), mk("f", "pinterest", "pin", 35),
    mk("g", "facebook", "reel", 70), mk("h", "threads", "post", 70), mk("i", "youtube", "short", 21)];
  const lists = accounts.map((a) => buildSlots(a, WEEK, TZ));
  separateSlots(lists, () => TZ);
  const slots = lists.flat();
  assert.ok(slots.length > 500);
  const counts = Array(60).fill(0);
  for (const s of slots) counts[Number(s.localTime.slice(3))] += 1;
  for (const q of [0, 15, 30, 45]) assert.equal(counts[q], 0, `nobody posts at :${q}`);
  assert.ok(counts.filter((c, m) => c > 0 && ![0, 15, 30, 45].includes(m)).length >= 50, "almost every other minute gets used");
  const blocks = [0, 10, 20, 30, 40, 50].map((b) => counts.slice(b, b + 10).reduce((x, y) => x + y, 0));
  assert.ok(Math.max(...blocks) <= 1.5 * Math.min(...blocks), `ten-minute blocks are even enough: ${blocks.join(" ")}`);
  for (const s of slots) assert.ok(goodMinute(Number(s.localTime.slice(3))), `${s.localTime}`);
});

test("moving a time off a round number keeps the spacing close to equal", () => {
  const m = spreadMinutes(6, timeProfileOf("tiktok"), "seed");
  for (const g of m.slice(1).map((x, i) => x - m[i])) assert.ok(Math.abs(g - 120) <= 22, `gap ${g}`);
});
