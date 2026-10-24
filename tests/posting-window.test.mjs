import test from "node:test";
import assert from "node:assert/strict";
import { clampWindow, spreadMinutes, localMinutes, setPostingWindow } from "../services/dev-api-lambda/posting-window.mjs";

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

test("a rule window is clamped into the official window and a missing end stays missing", () => {
  assert.deepEqual(clampWindow({ preferredStartTime: "07:00", preferredEndTime: "23:30" }, 600, 1320), { start: "10:00", end: "22:00" });
  assert.deepEqual(clampWindow({ preferredStartTime: "12:00", preferredEndTime: "18:00" }, 600, 1320), { start: "12:00", end: "18:00" });
  assert.deepEqual(clampWindow({ preferredStartTime: "08:00", preferredEndTime: null }, 600, 1320), { start: "10:00", end: null });
});

test("posts spread evenly on the quarter hour; one post sits at the start, or mid-window today", () => {
  assert.deepEqual(spreadMinutes(3, 600, 1020), [600, 810, 1020]);
  assert.deepEqual(spreadMinutes(1, 600, 1020), [600]);
  assert.deepEqual(spreadMinutes(1, 1050, 1320, true), [1185]);
});

test("local minutes follow the time zone, including daylight saving", () => {
  assert.equal(localMinutes(new Date("2026-10-24T20:50:00Z"), "America/New_York"), 16 * 60 + 50);
  assert.equal(localMinutes(new Date("2026-11-02T20:50:00Z"), "America/New_York"), 15 * 60 + 50);
});

test("preview moves only unpublished posts outside the window and writes nothing", async () => {
  const writes = [];
  const rule = { id: "r1", placement: "story", preferredStartTime: "07:00", preferredEndTime: "23:30", accountId: "a1", destination: "instagram", timeZone: "America/New_York" };
  const client = {
    query: async (text, values) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      if (text.includes('FROM "CadenceRule"')) return { rows: [rule] };
      if (text.includes('FROM "ScheduledPost"')) {
        assert.deepEqual(values[3], ["planned", "approved"]);
        return { rows: [{ id: "p1", scheduledFor: "2026-10-26T11:00:00Z" }, { id: "p2", scheduledFor: "2026-10-26T19:30:00Z" }, { id: "p3", scheduledFor: "2026-10-27T03:30:00Z" }] };
      }
      if (text.includes('FROM "Brand"')) return { rows: [{ id: "b1", slug: "stashbox", timezone: "America/New_York", settings: {} }] };
      writes.push(text);
      return { rows: [] };
    },
    end: async () => {}
  };
  const out = JSON.parse((await setPostingWindow({ brandSlug: "stashbox" }, async () => client, json, new Date("2026-10-24T21:00:00Z"))).body);
  assert.equal(out.mode, "preview");
  assert.deepEqual(writes, []);
  assert.deepEqual(out.ruleChanges.map((c) => c.to), ["10:00-22:00"]);
  assert.deepEqual(out.postChanges.map((c) => c.local), ["2026-10-26 10:00", "2026-10-26 13:30", "2026-10-26 17:00"]);
});
