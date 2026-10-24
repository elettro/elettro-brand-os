// IAM-only: bring a brand's posting window and its not-yet-published posts inside one daily window.
//   set-posting-window  preview (default) or apply (mode:"apply"): clamp every active CadenceRule to the
//                       official window [start, end] and re-spread the planned/approved future posts of any
//                       account + format + day that has one outside it, into the primary window
//                       [primaryStart, primaryEnd]. Published, publishing, failed and skipped posts are
//                       never touched.
import { withClient, loadBrand } from "./planner-v2-db.mjs";
import { addDaysToYmd, localDateTimeToUtc, ymdInTimeZone } from "./planner-v2.mjs";

const HHMM = /^(\d{1,2}):(\d{2})$/;
const MOVABLE = ["planned", "approved"];
const minutesOf = (hhmm) => { const m = HHMM.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const quarter = (min) => Math.round(min / 15) * 15;

// Local clock minutes of an instant in a time zone.
export function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

// Rule window clamped to [start, end]; a missing end stays missing (the planner reads it as "at start").
export function clampWindow(rule, start, end) {
  const s = minutesOf(rule.preferredStartTime);
  const e = minutesOf(rule.preferredEndTime);
  const newStart = s === null ? start : Math.min(Math.max(s, start), end);
  const newEnd = e === null ? null : Math.max(Math.min(e, end), newStart);
  return { start: hhmmOf(newStart), end: newEnd === null ? null : hhmmOf(newEnd) };
}

// Local minutes for n posts in [lo, hi], on the quarter hour. One post sits at lo, or mid-window today.
export function spreadMinutes(n, lo, hi, today = false) {
  if (n === 1) return [today ? quarter((lo + hi) / 2) : lo];
  return Array.from({ length: n }, (_, k) => Math.min(hi, quarter(lo + (k * (hi - lo)) / (n - 1))));
}

export async function setPostingWindow(event, connectDatabase, json, now = new Date()) {
  const start = minutesOf(event.start || "10:00");
  const end = minutesOf(event.end || "22:00");
  const pStart = minutesOf(event.primaryStart || "10:00");
  const pEnd = minutesOf(event.primaryEnd || "17:00");
  if ([start, end, pStart, pEnd].includes(null) || end <= start || pEnd <= pStart || pStart < start || pEnd > end) {
    return json(400, { ok: false, error: "start, end, primaryStart and primaryEnd (HH:MM) are required; the primary window must sit inside the official one" });
  }
  const apply = event.mode === "apply";
  return withClient(connectDatabase, json, "set-posting-window", async (client) => {
    const brand = await loadBrand(client, String(event.brandSlug || ""));
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const rules = (await client.query(
      `SELECT cr."id", cr."placement", cr."preferredStartTime", cr."preferredEndTime", sa."id" AS "accountId", sa."destination",
              COALESCE(sa."timezone", $2) AS "timeZone"
       FROM "CadenceRule" cr JOIN "SocialAccount" sa ON sa."id" = cr."socialAccountId"
       WHERE sa."brandId" = $1 AND sa."status" = 'active' AND cr."active" = TRUE`, [brand.id, brand.timezone || "America/New_York"])).rows;
    const ruleChanges = [];
    const postChanges = [];
    await client.query("BEGIN");
    try {
      for (const rule of rules) {
        const next = clampWindow(rule, start, end);
        if (next.start !== rule.preferredStartTime || next.end !== rule.preferredEndTime) {
          ruleChanges.push({ destination: rule.destination, placement: rule.placement, from: `${rule.preferredStartTime}-${rule.preferredEndTime || ""}`, to: `${next.start}-${next.end || ""}` });
          if (apply) await client.query('UPDATE "CadenceRule" SET "preferredStartTime"=$2, "preferredEndTime"=$3, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [rule.id, next.start, next.end]);
        }
        const posts = (await client.query(
          `SELECT "id", "scheduledFor" FROM "ScheduledPost"
           WHERE "brandId"=$1 AND "socialAccountId"=$2 AND "placement"=$3 AND "status" = ANY($4) AND "scheduledFor" > $5
           ORDER BY "scheduledFor"`, [brand.id, rule.accountId, rule.placement, MOVABLE, now])).rows;
        const tz = rule.timeZone;
        const todayYmd = ymdInTimeZone(now, tz);
        // Earliest a post may go out today: 20 minutes from now, on the quarter hour.
        const earliest = Math.ceil((localMinutes(now, tz) + 20) / 15) * 15;
        const days = new Map();
        for (const p of posts) {
          const at = new Date(p.scheduledFor);
          const ymd = ymdInTimeZone(at, tz);
          if (!days.has(ymd)) days.set(ymd, []);
          days.get(ymd).push({ id: p.id, at, mins: localMinutes(at, tz) });
        }
        for (const ymd of [...days.keys()].sort()) {
          const items = days.get(ymd);
          if (items.every((i) => i.mins >= start && i.mins <= end)) continue;
          const isToday = ymd === todayYmd;
          const lo = isToday ? Math.max(pStart, earliest) : pStart;
          let target = ymd;
          let slots;
          if (lo > end) { // too late to fit today: the whole day's remainder goes to tomorrow's primary window
            target = addDaysToYmd(ymd, 1);
            slots = spreadMinutes(items.length, pStart, pEnd);
          } else slots = spreadMinutes(items.length, lo, lo <= pEnd ? pEnd : end, isToday);
          items.forEach((item, k) => {
            const when = localDateTimeToUtc(target, hhmmOf(slots[k]), tz);
            postChanges.push({ id: item.id, destination: rule.destination, placement: rule.placement, from: item.at.toISOString(), to: when.toISOString(), local: `${target} ${hhmmOf(slots[k])}` });
          });
        }
      }
      if (apply) {
        for (const c of postChanges) {
          await client.query(`UPDATE "ScheduledPost" SET "scheduledFor"=$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status" = ANY($3)`, [c.id, c.to, MOVABLE]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    return json(200, { ok: true, mode: apply ? "apply" : "preview", window: `${hhmmOf(start)}-${hhmmOf(end)}`, primary: `${hhmmOf(pStart)}-${hhmmOf(pEnd)}`, ruleChanges, postChanges });
  });
}
