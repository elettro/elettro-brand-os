import test from "node:test";
import assert from "node:assert/strict";
import { slotsToPlan } from "../services/dev-api-lambda/planner-v2.mjs";

// 5 a day (35 a week), 12:00-18:00 Eastern. Tuesday 2026-10-27 at 15:10 EDT = 19:10Z.
const account = { socialAccountId: "a1", destination: "pinterest", placement: "pin", postsPerWeek: 35, preferredDays: [], preferredStartTime: "12:00", preferredEndTime: "18:00" };
const tuesday3pm = new Date("2026-10-27T19:10:00Z");
const today = (slots) => slots.filter((s) => s.ymd === "2026-10-27");

test("with nothing out yet today, a replan tops today up to its full daily count in what's left of the window", () => {
  const t = today(slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 0));
  assert.equal(t.length, 5); // all 5 fit between 15:15 and 18:00
  assert.ok(t.every((x) => new Date(x.scheduledFor) > tuesday3pm));
});

test("posts that already went out today are subtracted, and the rest spread over what's left of the window", () => {
  const t = today(slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 3));
  assert.equal(t.length, 2);
  assert.ok(t.every((s) => new Date(s.scheduledFor) > tuesday3pm));
  assert.deepEqual(t.map((s) => s.localTime), ["15:15", "18:00"]);
});

test("a day whose quota already went out gets nothing more, and later days stay full", () => {
  const slots = slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 5);
  assert.equal(today(slots).length, 0);
  assert.equal(slots.filter((s) => s.ymd === "2026-10-28").length, 5);
  assert.equal(slots.length, 5 * 5); // Wed-Sun
});

test("after the window has closed, today gets no slots", () => {
  const late = new Date("2026-10-27T23:30:00Z"); // 19:30 EDT
  assert.equal(today(slotsToPlan(account, "2026-10-26", "America/New_York", late, 0)).length, 0);
});
