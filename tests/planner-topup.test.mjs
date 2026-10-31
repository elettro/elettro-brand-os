import test from "node:test";
import assert from "node:assert/strict";
import { slotsToPlan } from "../services/dev-api-lambda/planner-v2.mjs";

// 5 a day (35 a week) on Pinterest, whose window is 09:00-21:00 Eastern. Tuesday 2026-10-27 at 15:10 EDT = 19:10Z.
const account = { socialAccountId: "a1", destination: "pinterest", placement: "pin", postsPerWeek: 35, preferredDays: [] };
const tuesday3pm = new Date("2026-10-27T19:10:00Z");
const today = (slots) => slots.filter((s) => s.ymd === "2026-10-27");
const minutes = (slots) => slots.map((s) => Number(s.localTime.slice(0, 2)) * 60 + Number(s.localTime.slice(3)));

test("with nothing out yet today, a replan tops today up to its full daily count in what's left of the window", () => {
  const t = today(slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 0));
  assert.equal(t.length, 5); // all 5 fit between 15:30 (20 minutes of lead) and 21:00
  assert.ok(t.every((x) => new Date(x.scheduledFor) > new Date(tuesday3pm.getTime() + 20 * 60000)));
  assert.ok(minutes(t).every((m) => m < 21 * 60 && m % 5 !== 0), "inside the window, never on a multiple of 5 minutes");
});

test("posts that already went out today are subtracted, and the rest spread equally over what's left of the window", () => {
  const t = today(slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 3));
  assert.equal(t.length, 2);
  const m = minutes(t);
  assert.ok(m[0] >= 15 * 60 + 30 && m[1] < 21 * 60);
  assert.ok(m[1] - m[0] >= 90, "two posts over the remaining 5.5 hours are far apart");
});

test("a day whose quota already went out gets nothing more, and later days stay full", () => {
  const slots = slotsToPlan(account, "2026-10-26", "America/New_York", tuesday3pm, 5);
  assert.equal(today(slots).length, 0);
  assert.equal(slots.filter((s) => s.ymd === "2026-10-28").length, 5);
  assert.equal(slots.length, 5 * 5); // Wed-Sun
});

test("after the window has closed, today gets no slots", () => {
  const late = new Date("2026-10-28T01:30:00Z"); // 21:30 EDT
  assert.equal(today(slotsToPlan(account, "2026-10-26", "America/New_York", late, 0)).length, 0);
});
