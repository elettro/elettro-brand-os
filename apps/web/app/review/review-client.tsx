"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReviewList, ReviewPost, TiktokCreator } from "@/lib/planner-review";
import { AssetThumb as Thumb } from "@/components/asset-thumb";
import { TiktokCard } from "./tiktok-card";

const NETWORK: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };
// One posts-per-day setting per network and placement; TikTok's planner placement is "video".
const SLOTS = [
  { destination: "instagram", placement: "reel", label: "Reels" },
  { destination: "instagram", placement: "story", label: "Stories" },
  { destination: "facebook", placement: "reel", label: "Reels" },
  { destination: "facebook", placement: "story", label: "Stories" },
  { destination: "tiktok", placement: "video", label: "Videos" }
] as const;
const slotKey = (s: { destination: string; placement: string }) => `${s.destination}:${s.placement}`;

function addDays(ymd: string, days: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function act(body: Record<string, unknown>) {
  const response = await fetch("/api/planner/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string } & Partial<ReviewList>;
  if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

// The planner stores hashtags with their "#"; edited ones are stored without. Show exactly one.
const tag = (h: string) => "#" + h.replace(/^#+/, "");

export function ReviewClient({ initial }: { initial: ReviewList }) {
  const [list, setList] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [swapping, setSwapping] = useState<string | null>(null);
  const tz = list.timeZone;
  const brand = list.brand;

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const ymdOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
  const today = ymdOf(new Date().toISOString());
  const reviewable = (p: ReviewPost) => ["planned", "approved", "skipped"].includes(p.status);

  const weeks = useMemo(() => Array.from({ length: list.weeks }, (_, i) => {
    const start = addDays(list.weekStart, 7 * i);
    const end = addDays(start, 6);
    const posts = list.posts.filter((p) => { const d = ymdOf(p.scheduledFor); return d >= start && d <= end; });
    const days = new Map<string, ReviewPost[]>();
    for (const p of posts) days.set(ymdOf(p.scheduledFor), [...(days.get(ymdOf(p.scheduledFor)) || []), p]);
    return { start, end, posts, days: [...days.entries()] };
  }), [list]);

  const perDay = (destination: string, placement: string) => {
    const rule = list.accounts.find((a) => a.destination === destination && a.placement === placement && a.active);
    return rule?.postsPerWeek ? Math.round(rule.postsPerWeek / 7) : 0;
  };
  const connected = (destination: string) => list.accounts.find((a) => a.destination === destination && a.externalAccountId);
  // Weeks fold so one can be read on its own; the current week starts open.
  const [open, setOpen] = useState(() => new Set([list.weekStart]));
  const toggle = (start: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(start)) next.delete(start); else next.add(start);
    return next;
  });
  const [cadence, setCadence] = useState<Record<string, number>>(() =>
    Object.fromEntries(SLOTS.map((s) => [slotKey(s), perDay(s.destination, s.placement)])));
  // TikTok's card needs the account's current settings from TikTok, fetched once per page load.
  const hasTiktok = list.posts.some((p) => p.destination === "tiktok" && reviewable(p));
  const [creator, setCreator] = useState<TiktokCreator | null>(null);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  useEffect(() => {
    if (!hasTiktok || creator || creatorError) return;
    fetch(`/api/tiktok/creator?brand=${brand}`).then(async (r) => {
      const data = await r.json().catch(() => ({})) as TiktokCreator & { ok?: boolean; error?: string };
      if (r.ok && data.ok) setCreator(data); else setCreatorError(data.error || `HTTP ${r.status}`);
    }).catch(() => setCreatorError("Elettro OS could not reach TikTok"));
  }, [hasTiktok, brand, creator, creatorError]);

  async function run(label: string, body: Record<string, unknown>, done?: string) {
    setBusy(label);
    setNotice(null);
    try {
      const result = await act({ brand, ...body });
      const fresh = await act({ brand, action: "list", weekStart: list.weekStart, weeks: list.weeks });
      setList(fresh as ReviewList);
      if (done) setNotice(done);
      return result;
    } catch (error) {
      setNotice(`Not saved: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function saveCadence() {
    const saved = SLOTS.filter((s) => connected(s.destination));
    for (const s of saved) {
      await run("cadence", { action: "cadence", destination: s.destination, placement: s.placement, postsPerWeek: cadence[slotKey(s)] * 7 });
    }
    setNotice(`Saved: ${saved.map((s) => `${NETWORK[s.destination]} ${s.label} ${cadence[slotKey(s)]}/day`).join(", ")}. Plan a week to use it.`);
  }

  return <div className="review">
    <section className="card review-settings">
      <div>
        <div className="eyebrow">Posts per day</div>
        {SLOTS.map((s) => (
          <label key={slotKey(s)} className="review-cadence">
            {NETWORK[s.destination]} {s.label} {connected(s.destination) ? <b>{connected(s.destination)!.accountName}</b> : <span className="muted">not connected</span>}
            <input type="number" min={0} max={10} value={cadence[slotKey(s)]} disabled={!connected(s.destination)}
              onChange={(e) => setCadence({ ...cadence, [slotKey(s)]: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} />
          </label>
        ))}
        <button className="status-chip" disabled={!!busy} onClick={saveCadence}>Save</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Planning picks clips from the approved content pool and writes captions; it takes a minute or two, then refresh.
        Replanning a week replaces only its posts that are not approved yet.
      </p>
    </section>

    {notice && <p className="card review-notice">{notice}</p>}

    {weeks.map((w) => {
      const planned = w.posts.filter((p) => p.status === "planned").length;
      const approved = w.posts.filter((p) => p.status === "approved").length;
      const skipped = w.posts.filter((p) => p.status === "skipped").length;
      const isOpen = open.has(w.start);
      // The week under way plans only its remaining days; the planner skips slots already past.
      const underway = w.start <= today;
      return <section key={w.start} className={`review-week${isOpen ? " open" : ""}`}>
        <header onClick={(e) => { if (!(e.target as HTMLElement).closest(".review-actions")) toggle(w.start); }}>
          <button type="button" className="review-week-toggle" aria-expanded={isOpen}>
            <span className="review-chevron" aria-hidden="true">▸</span>
            <h2>Week of {new Date(w.start + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</h2>
          </button>
          <span className="muted">{w.posts.length ? `${approved} approved · ${planned} to review · ${skipped} skipped` : "Nothing planned yet"}</span>
          <div className="review-actions">
            {planned > 0 && <button className="status-chip" disabled={!!busy}
              title="TikTok posts are approved one at a time from their TikTok card"
              onClick={() => run("week", { action: "approve-range", from: w.start, to: w.end }, "Approved the week's Facebook and Instagram posts. TikTok posts need their TikTok card.")}>Approve week</button>}
            {w.end >= today && <button className="status-chip" disabled={!!busy || !list.accounts.some((a) => a.active && a.postsPerWeek)}
              title={list.accounts.some((a) => a.active && a.postsPerWeek) ? "" : "Set posts per day first"}
              onClick={() => run("plan", { action: "plan", weekStart: w.start }, `Planning ${underway ? "the rest of " : ""}the week of ${w.start}. Refresh in a minute or two.`)}>
              {underway ? (w.posts.length ? "Replan rest of week" : "Plan rest of week") : (w.posts.length ? "Replan unapproved" : "Plan this week")}
            </button>}
          </div>
        </header>
        {isOpen && w.days.map(([day, posts]) => <div key={day} className="review-day">
          <h3>{fmtDay(posts[0].scheduledFor)}</h3>
          <div className="review-posts">
            {posts.map((p) => <article key={p.id} className={`review-post status-${p.status}`}>
              <Thumb asset={p.asset} />
              <div className="review-body">
                <div className="review-meta">
                  <b>{NETWORK[p.destination] || p.destination}</b> · {p.placement} · {fmtTime(p.scheduledFor)}
                  <span className={`review-status ${p.status}`}>{p.status === "planned" ? "to review" : p.status}</span>
                </div>
                {p.captionStale && <p className="review-warn">Clip was swapped. Check the caption still fits.</p>}
                {p.copyStatus && p.copyStatus !== "ready" && <p className="review-warn">Caption needs work ({p.copyStatus}).</p>}
                {editing === p.id ? <div className="review-edit">
                  <textarea rows={6} maxLength={2200} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="review-actions">
                    <button className="status-chip" disabled={!!busy || !draft.trim()} onClick={async () => {
                      const [text, ...tags] = draft.split(/\n\s*(?=#)/);
                      await run(p.id, { action: "edit", id: p.id, caption: text.trim(), hashtags: tags.join(" ").split(/\s+/).filter((t) => t.startsWith("#")) }, "Caption saved.");
                      setEditing(null);
                    }}>Save caption</button>
                    <button className="status-chip" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div> : <p className="review-caption">{p.caption || <span className="muted">No caption yet</span>}
                  {p.hashtags.length > 0 && <span className="review-tags"> {p.hashtags.map(tag).join(" ")}</span>}</p>}
                <p className="muted review-file">{p.asset.title || p.asset.filename}{p.sector ? ` · ${p.sector}` : ""}</p>
                {reviewable(p) && p.destination === "tiktok" && p.status !== "skipped" && <TiktokCard post={p} creator={creator} creatorError={creatorError} busy={!!busy}
                  onApprove={(settings) => run(p.id, { action: "tiktok-approve", id: p.id, ...settings }, "Approved for TikTok with these settings.")} />}
                {reviewable(p) && <div className="review-actions">
                  {p.status !== "approved" && p.destination !== "tiktok" && <button className="status-chip" disabled={!!busy} onClick={() => run(p.id, { action: "set-status", ids: [p.id], status: "approved" })}>Approve</button>}
                  {p.status !== "skipped" && <button className="status-chip" disabled={!!busy} onClick={() => run(p.id, { action: "set-status", ids: [p.id], status: "skipped" })}>Skip</button>}
                  {p.status !== "planned" && <button className="status-chip" disabled={!!busy} onClick={() => run(p.id, { action: "set-status", ids: [p.id], status: "planned" })}>Undo</button>}
                  {editing !== p.id && <button className="status-chip" disabled={!!busy} onClick={() => {
                    setEditing(p.id);
                    setDraft([p.caption || "", p.hashtags.map(tag).join(" ")].filter(Boolean).join("\n\n"));
                  }}>Edit caption</button>}
                  {p.candidates.length > 0 && <button className="status-chip" disabled={!!busy} onClick={() => setSwapping(swapping === p.id ? null : p.id)}>Swap clip</button>}
                </div>}
                {swapping === p.id && <div className="review-swap">
                  {p.candidates.map((c) => <button key={c.id} disabled={!!busy} title={`Use ${c.filename}`}
                    onClick={async () => { await run(p.id, { action: "swap", id: p.id, assetId: c.id }, "Clip swapped. Check the caption."); setSwapping(null); }}>
                    <Thumb asset={c} size={72} />
                  </button>)}
                </div>}
              </div>
            </article>)}
          </div>
        </div>)}
      </section>;
    })}
  </div>;
}
