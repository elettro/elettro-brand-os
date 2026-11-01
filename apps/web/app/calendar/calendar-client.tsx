"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarMonth, CalendarPost } from "@/lib/planner-review";
import { AssetThumb as Thumb } from "@/components/asset-thumb";

const NETWORK: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", threads: "Threads", bluesky: "Bluesky", youtube: "YouTube",
  pinterest: "Pinterest", mastodon: "Mastodon", linkedin: "LinkedIn", x: "X", gmb: "Google Business"
};
const SHORT: Record<string, string> = { instagram: "IG", facebook: "FB", tiktok: "TT", threads: "TH", bluesky: "BS", mastodon: "MA", youtube: "YT", pinterest: "PIN", linkedin: "LI", x: "X", gmb: "GBP" };
// Caption limits the networks enforce (the API caps every caption at 2,200).
const CAPTION_MAX: Record<string, number> = { threads: 500, bluesky: 300, mastodon: 500, pinterest: 500, x: 280 };
const TITLE_NETWORKS = ["youtube", "pinterest"];
const TITLE_MAX = 100;
// The publisher ticks every 15 minutes; posts due sooner are locked (same rule as the API).
const LOCK_MS = 15 * 60 * 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHIPS_PER_DAY = 4;

function addDays(ymd: string, days: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
// The time box works in the brand's own time zone: "2026-10-28T09:00" in, a UTC instant out, and back.
function localInput(iso: string, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function instantOf(local: string, tz: string) {
  const [d, t] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const back = localInput(new Date(guess).toISOString(), tz).split("T");
  const [by, bmo, bda] = back[0].split("-").map(Number);
  const [bh, bmi] = back[1].split(":").map(Number);
  return new Date(guess - (Date.UTC(by, bmo - 1, bda, bh, bmi) - guess)).toISOString();
}
const tag = (h: string) => "#" + h.replace(/^#+/, "");

async function act<T = { ok: boolean; error?: string }>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/planner/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

// What a post's badge says.
function stateOf(p: CalendarPost): { key: string; label: string } {
  if (p.status === "published") return { key: "published", label: "Published" };
  if (p.status === "paused") return p.passedOver ? { key: "passed", label: "Passed over" } : { key: "paused", label: "Paused" };
  if (p.status === "approved") return new Date(p.at).getTime() < Date.now() ? { key: "sending", label: "Sending" } : { key: "approved", label: "Approved" };
  return { key: "sending", label: "Sending now" };
}

type Toast = { text: string; undo?: () => Promise<void> };

export function CalendarClient({ initial, brandName }: { initial: CalendarMonth; brandName?: string }) {
  const [data, setData] = useState(initial);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ when: "", title: "", caption: "", hashtags: "" });
  const tz = data.timeZone;
  const brand = data.brand;

  const ymdOf = useCallback((iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }), [tz]);
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const fmtLong = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
  const fmtDay = (ymd: string) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const monthLabel = new Date(data.month + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const networks = useMemo(() => [...new Set(data.posts.map((p) => p.destination))].sort(), [data.posts]);
  const visible = data.posts.filter((p) => !hidden.includes(p.destination));
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const p of visible) {
      const d = ymdOf(p.at);
      (map.get(d) || map.set(d, []).get(d)!).push(p);
    }
    return map;
  }, [visible, ymdOf]);
  // Per-day tallies for the grid: published posts vs. posts still lined up to go out (paused/removed don't count).
  const tally = (list: CalendarPost[]) => ({
    posted: list.filter((p) => p.kind === "published").length,
    scheduled: list.filter((p) => p.kind === "scheduled" && p.status !== "paused").length
  });
  const days = Array.from({ length: 42 }, (_, i) => addDays(data.start, i));
  const post = selected ? data.posts.find((p) => p.id === selected) || null : null;
  // Nothing approved to come (any month): an encouraging note with a big way to Review instead of a bare grid.
  const nothingApproved = data.upcomingApproved !== undefined ? data.upcomingApproved === 0
    : !data.posts.some((p) => p.status === "approved" && new Date(p.at).getTime() >= Date.now());

  const load = useCallback(async (month: string) => {
    setBusy("load");
    setError(null);
    try {
      const next = await act<CalendarMonth>({ brand, action: "calendar", month });
      setData(next);
      const url = new URL(window.location.href);
      url.searchParams.set("brand", brand);
      url.searchParams.set("month", next.month);
      window.history.replaceState(null, "", url.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the month");
    } finally {
      setBusy(null);
    }
  }, [brand]);

  // Keep today's Posted / Scheduled live: quietly re-read the month every minute (only while the tab is visible and idle).
  useEffect(() => {
    if (data.month !== data.today.slice(0, 7)) return;
    const month = data.month;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible" || busy || selected || editing) return;
      try { setData(await act<CalendarMonth>({ brand, action: "calendar", month })); } catch { /* try again next minute */ }
    }, 60_000);
    return () => clearInterval(t);
  }, [brand, data.month, data.today, busy, selected, editing]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelected(null); setDayOpen(null); setEditing(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const open = (p: CalendarPost) => { setSelected(p.id); setEditing(false); setError(null); };

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try { await fn(); await load(data.month); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(null); }
  }
  const setStatus = (id: string, status: string) => act({ brand, action: "set-status", ids: [id], status });

  function startEdit(p: CalendarPost) {
    setDraft({ when: localInput(p.at, tz), title: p.title || "", caption: p.caption || "", hashtags: p.hashtags.map(tag).join(" ") });
    setEditing(true);
  }
  async function saveEdit(p: CalendarPost) {
    const hashtags = draft.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#+/, "").trim()).filter(Boolean);
    const textChanged = draft.caption !== (p.caption || "") || draft.title !== (p.title || "") || hashtags.join(" ") !== p.hashtags.map((h) => h.replace(/^#+/, "")).join(" ");
    const whenIso = instantOf(draft.when, tz);
    const timeChanged = draft.when !== localInput(p.at, tz);
    if (timeChanged && new Date(whenIso).getTime() < Date.now() + LOCK_MS) throw Error("Pick a time at least 15 minutes from now");
    if (textChanged) {
      await act({ brand, action: "edit", id: p.postId, caption: draft.caption.trim(), hashtags,
        ...(TITLE_NETWORKS.includes(p.destination) ? { title: draft.title.trim() } : {}) });
    }
    if (timeChanged) await act({ brand, action: "reschedule", id: p.postId, scheduledFor: whenIso });
    setEditing(false);
  }

  const captionMax = post ? CAPTION_MAX[post.destination] ?? 2200 : 2200;
  const draftProblem = !post ? null
    : !draft.caption.trim() ? "The caption can't be empty"
    : draft.caption.length > captionMax ? `${NETWORK[post.destination] || post.destination} takes at most ${captionMax} characters`
    : TITLE_NETWORKS.includes(post.destination) && (!draft.title.trim() || draft.title.length > TITLE_MAX) ? `The title needs 1-${TITLE_MAX} characters`
    : !draft.when ? "Pick a date and time" : null;

  const chip = (p: CalendarPost) => {
    const s = stateOf(p);
    return <button key={p.id} type="button" className={`cal-chip net-${p.destination} st-${s.key}`} onClick={() => open(p)}
      title={`${NETWORK[p.destination] || p.destination} · ${p.placement} · ${s.label}`}>
      <span className="cal-chip-net">{SHORT[p.destination] || p.destination}</span>
      <span className="cal-chip-time">{fmtTime(p.at)}</span>
      {s.key === "paused" || s.key === "passed" ? <span className="cal-chip-mark" aria-label={s.label}>⏸</span> : s.key === "published" ? <span className="cal-chip-mark ok" aria-label="Published">✓</span> : null}
    </button>;
  };

  return <div className="cal">
    <div className="cal-bar">
      <div className="cal-nav">
        <button type="button" className="cal-btn" aria-label="Previous month" disabled={!!busy} onClick={() => load(shiftMonth(data.month, -1))}>‹</button>
        <h2 className="cal-month">{monthLabel}</h2>
        <button type="button" className="cal-btn" aria-label="Next month" disabled={!!busy} onClick={() => load(shiftMonth(data.month, 1))}>›</button>
        <button type="button" className="cal-btn" disabled={!!busy || data.month === data.today.slice(0, 7)} onClick={() => load(data.today.slice(0, 7))}>Today</button>
        {busy === "load" && <span className="muted">Loading…</span>}
      </div>
      {networks.length > 1 && <div className="cal-filters" role="group" aria-label="Networks">
        {networks.map((n) => <button key={n} type="button" aria-pressed={!hidden.includes(n)} className={`cal-filter net-${n}${hidden.includes(n) ? " off" : ""}`}
          onClick={() => setHidden((h) => h.includes(n) ? h.filter((x) => x !== n) : [...h, n])}>{NETWORK[n] || n}</button>)}
      </div>}
    </div>
    <p className="muted cal-tz">Times are {tz.replace("_", " ")}. Past days show what published; coming days show approved and paused posts.</p>
    {error && !post && <p className="cal-error" role="alert">{error}</p>}

    {nothingApproved && <section className="cal-empty" aria-label="Nothing approved yet">
      <div className="cal-empty-art" aria-hidden="true">🗓️✨</div>
      <h2>Your calendar is wide open. Let&apos;s fill it.</h2>
      <p>{brandName || "This brand"} has no approved posts coming up yet. Pop over to Review, give the posts you like a thumbs-up, and they&apos;ll land right here, lined up to go out on time.</p>
      <a className="cal-empty-cta" href={`/review?brand=${encodeURIComponent(brand)}`}>Approve posts on Review <span aria-hidden="true">→</span></a>
    </section>}

    <div className="cal-grid" role="grid" aria-label={monthLabel}>
      {WEEKDAYS.map((d) => <div key={d} className="cal-weekday" role="columnheader">{d}</div>)}
      {days.map((d) => {
        const list = byDay.get(d) || [];
        const outside = d.slice(0, 7) !== data.month;
        return <div key={d} role="gridcell" className={`cal-day${outside ? " outside" : ""}${d === data.today ? " today" : ""}${d < data.today ? " past" : ""}`}>
          <div className="cal-date-row">
            <span className="cal-date">{Number(d.slice(8))}</span>
            {(() => {
              const t = tally(list);
              const posted = d <= data.today ? <span key="p">Posted: {t.posted}</span> : null;
              const sched = d >= data.today && t.scheduled > 0 ? <span key="s">Scheduled: {t.scheduled}</span> : null;
              return posted || sched ? <span className="cal-stat">{posted}{sched}</span> : null;
            })()}
          </div>
          {list.slice(0, CHIPS_PER_DAY).map(chip)}
          {list.length > CHIPS_PER_DAY && <button type="button" className="cal-more" onClick={() => setDayOpen(d)}>+{list.length - CHIPS_PER_DAY} more</button>}
        </div>;
      })}
    </div>

    {/* Phones: a day-by-day list instead of the grid. */}
    <div className="cal-agenda">
      {days.filter((d) => d.slice(0, 7) === data.month && byDay.get(d)?.length).map((d) => <section key={d} className={`cal-agenda-day${d === data.today ? " today" : ""}`}>
        <h3>{fmtDay(d)}</h3>
        {byDay.get(d)!.map(chip)}
      </section>)}
      {!nothingApproved && !visible.some((p) => ymdOf(p.at).slice(0, 7) === data.month) && <p className="muted">Nothing published or approved this month.</p>}
    </div>

    {dayOpen && !post && <div className="cal-scrim" onClick={() => setDayOpen(null)}>
      <aside className="cal-panel" aria-label={fmtDay(dayOpen)} onClick={(e) => e.stopPropagation()}>
        <div className="cal-panel-head"><h3>{fmtDay(dayOpen)}</h3><button type="button" className="cal-btn" aria-label="Close" onClick={() => setDayOpen(null)}>✕</button></div>
        <div className="cal-day-list">{(byDay.get(dayOpen) || []).map(chip)}</div>
      </aside>
    </div>}

    {post && <div className="cal-scrim" onClick={() => { setSelected(null); setEditing(false); }}>
      <aside className="cal-panel" aria-label="Post" onClick={(e) => e.stopPropagation()}>
        <div className="cal-panel-head">
          <div>
            <div className={`cal-net net-${post.destination}`}>{NETWORK[post.destination] || post.destination} · {post.placement}{post.carousel ? " · carousel" : ""}</div>
            <div className="muted">{post.accountName}</div>
          </div>
          <button type="button" className="cal-btn" aria-label="Close" onClick={() => { setSelected(null); setEditing(false); }}>✕</button>
        </div>
        <div className="cal-when">
          <b>{fmtLong(post.at)}</b>
          <span className={`cal-badge st-${stateOf(post).key}`}>{stateOf(post).label}</span>
        </div>
        {post.passedOver && <p className="muted">This post was paused when its time came, so it was passed over and will not be sent.</p>}

        {!editing && <>
          <div className="cal-media">{post.custom ? <div className="muted">{post.custom.kind === "poll" ? "Poll" : post.custom.kind === "link" ? "Link post" : "Text post"}</div> : <Thumb asset={post.asset} size={220} />}</div>
          {post.title && <h4 className="cal-title">{post.title}</h4>}
          {post.caption ? <p className="cal-caption">{post.caption}</p> : <p className="muted">No caption on file.</p>}
          {post.hashtags.length > 0 && <p className="cal-tags">{post.hashtags.map(tag).join(" ")}</p>}
          {post.externalUrl && <p><a href={post.externalUrl} target="_blank" rel="noreferrer">View live post on {NETWORK[post.destination] || post.destination} ↗</a></p>}
          {post.kind === "published" && <div className="cal-stats">
            <div className="cal-stats-head">Stats</div>
            {post.stats ? <dl>{Object.entries(post.stats).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v.toLocaleString()}</dd></div>)}</dl>
              : <p className="muted">Views, likes and comments appear here once stats collection is switched on.</p>}
          </div>}
        </>}

        {editing && <form className="cal-edit" onSubmit={(e) => { e.preventDefault(); if (!draftProblem) void run("save", () => saveEdit(post)); }}>
          <label>Date and time ({tz.replace("_", " ")})
            <input type="datetime-local" value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value })} required />
          </label>
          {TITLE_NETWORKS.includes(post.destination) && <label>Title <small className="muted">{draft.title.length}/{TITLE_MAX}</small>
            <input value={draft.title} maxLength={TITLE_MAX} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>}
          <label>Caption <small className={draft.caption.length > captionMax ? "cal-over" : "muted"}>{draft.caption.length}/{captionMax}</small>
            <textarea rows={7} value={draft.caption} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} />
          </label>
          <label>Hashtags <small className="muted">separated by spaces</small>
            <input value={draft.hashtags} onChange={(e) => setDraft({ ...draft, hashtags: e.target.value })} />
          </label>
          {draftProblem && <p className="cal-error">{draftProblem}</p>}
          <div className="cal-actions">
            <button type="submit" className="cal-action primary" disabled={!!busy || !!draftProblem}>{busy === "save" ? "Saving…" : "Save"}</button>
            <button type="button" className="cal-action" disabled={!!busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>}

        {error && <p className="cal-error" role="alert">{error}</p>}

        {!editing && post.editable && post.postId && <div className="cal-actions">
          {post.status === "approved"
            ? <button type="button" className="cal-action" disabled={!!busy} onClick={() => run("pause", () => setStatus(post.postId!, "paused").then(() => {}))}>{busy === "pause" ? "Pausing…" : "Pause"}</button>
            : <button type="button" className="cal-action primary" disabled={!!busy} onClick={() => run("resume", () => setStatus(post.postId!, "approved").then(() => {}))}>{busy === "resume" ? "Resuming…" : "Resume"}</button>}
          <button type="button" className="cal-action" disabled={!!busy} onClick={() => startEdit(post)}>Edit</button>
          <button type="button" className="cal-action" disabled={!!busy || post.carousel || !!post.custom}
            title={post.carousel ? "Swap isn't available for carousels yet" : post.custom ? "Hand-written posts can't be swapped" : "Replace this post with a brand-new one: new clip, new caption"}
            onClick={() => run("swap", async () => { await act({ brand, action: "replan-slot", id: post.postId }); setToast({ text: "Swapped: new clip and new copy in this slot." }); })}>
            {busy === "swap" ? "Writing a new post…" : "Swap"}
          </button>
          <button type="button" className="cal-action danger" disabled={!!busy} onClick={() => {
            const id = post.postId!, was = post.status;
            void run("remove", async () => {
              await setStatus(id, "removed");
              setSelected(null);
              setToast({ text: "Post removed. It will not be sent.", undo: async () => { await setStatus(id, was); } });
            });
          }}>{busy === "remove" ? "Removing…" : "Remove"}</button>
        </div>}
        {!editing && post.kind === "scheduled" && !post.editable && !post.passedOver && <p className="muted">This post is going out now and can no longer be changed.</p>}
      </aside>
    </div>}

    {toast && <div className="cal-toast" role="status">
      <span>{toast.text}</span>
      {toast.undo && <button type="button" className="cal-action" disabled={!!busy} onClick={() => { const undo = toast.undo!; setToast(null); void run("undo", undo); }}>Undo</button>}
    </div>}
  </div>;
}
