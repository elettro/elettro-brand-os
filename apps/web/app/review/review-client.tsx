"use client";

import { useEffect, useMemo, useState } from "react";
import type { PublishingFormat, ReviewAccount, ReviewList, ReviewPost, TiktokCreator } from "@/lib/planner-review";
import { AssetThumb as Thumb } from "@/components/asset-thumb";
import { TiktokCard } from "./tiktok-card";

const NETWORK: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", threads: "Threads", youtube: "YouTube",
  pinterest: "Pinterest", linkedin: "LinkedIn", x: "X", gmb: "Google Business"
};
const STATUS: Record<PublishingFormat["status"], string> = {
  live: "auto-publishes", planning: "planned only", review: "awaiting app review", integration: "awaiting integration"
};
// A planner month is 4 weeks (plan-month / approve-month).
const WEEKS_PER_MONTH = 4;
// One posts-per-day setting per format of each connected account; a network with no connected
// account still shows its formats, disabled. Formats come from the API, so new ones appear on their own.
type Slot = { key: string; format: PublishingFormat; account: ReviewAccount | null };

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
  // A single TikTok post's settings open only on request; the week's TikTok box handles the rest.
  const [tiktokOpen, setTiktokOpen] = useState<string | null>(null);
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

  // list.accounts has one row per account and cadence rule; one entry per connected account here.
  const connectedAccounts = useMemo(() => [...new Map(list.accounts.filter((a) => a.externalAccountId)
    .map((a) => [a.socialAccountId, a])).values()], [list.accounts]);
  const slots = useMemo(() => (list.formats ?? []).flatMap((format): Slot[] => {
    const accounts = format.status === "integration" ? [] : connectedAccounts.filter((a) => a.destination === format.destination);
    if (!accounts.length) return [{ key: `${format.destination}:${format.placement}`, format, account: null }];
    return accounts.map((account) => ({ key: `${account.socialAccountId}:${format.placement}`, format, account }));
  }), [list.formats, connectedAccounts]);
  const savedWeekly = (s: Slot) => {
    const rule = s.account && list.accounts.find((a) => a.socialAccountId === s.account!.socialAccountId && a.placement === s.format.placement && a.active);
    return rule?.postsPerWeek || 0;
  };
  const maxWeek = list.maxPostsPerWeek || 70;
  // Weeks fold so one can be read on its own; the current week starts open.
  const [open, setOpen] = useState(() => new Set([list.weekStart]));
  const toggle = (start: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(start)) next.delete(start); else next.add(start);
    return next;
  });
  // Weekly numbers underneath; a box shows per day unless its number isn't a whole number of days.
  const [weekly, setWeekly] = useState<Record<string, number>>(() => Object.fromEntries(slots.map((s) => [s.key, savedWeekly(s)])));
  const [perWeek, setPerWeek] = useState<Record<string, boolean>>(() => Object.fromEntries(slots.map((s) => [s.key, savedWeekly(s) % 7 !== 0])));
  const weeklyOf = (s: Slot) => weekly[s.key] ?? savedWeekly(s);
  const networkGroups = useMemo(() => {
    const groups = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = s.account ? s.account.socialAccountId : s.format.destination;
      groups.set(key, [...(groups.get(key) || []), s]);
    }
    return [...groups.values()];
  }, [slots]);
  const groupWeekly = (group: Slot[]) => group.reduce((n, s) => n + (s.account ? weeklyOf(s) : 0), 0);
  const brandWeekly = networkGroups.reduce((n, g) => n + groupWeekly(g), 0);
  const overCap = networkGroups.filter((g) => groupWeekly(g) > maxWeek);
  const totals = (week: number) => `${week}/wk · ${week * WEEKS_PER_MONTH}/mo`;
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

  // Saves only the boxes that changed, lowering ones first so a network never passes 10 a day mid-save.
  async function saveCadence() {
    const changed = slots.filter((s) => s.account && s.format.status !== "integration" && weeklyOf(s) !== savedWeekly(s))
      .sort((a, b) => (weeklyOf(a) - savedWeekly(a)) - (weeklyOf(b) - savedWeekly(b)));
    if (!changed.length) { setNotice("Nothing changed."); return; }
    setBusy("cadence");
    setNotice(null);
    const done: string[] = [];
    try {
      for (const s of changed) {
        await act({ brand, action: "cadence", destination: s.format.destination, placement: s.format.placement,
          socialAccountId: s.account!.socialAccountId, postsPerWeek: weeklyOf(s) });
        done.push(`${NETWORK[s.format.destination] || s.format.destination} ${s.format.label} ${perWeek[s.key] ? `${weeklyOf(s)}/wk` : `${weeklyOf(s) / 7}/day`}`);
      }
      setNotice(`Saved: ${done.join(", ")}. Plan a week to use it.`);
    } catch (error) {
      setNotice(`${done.length ? `Saved ${done.join(", ")}; then not saved` : "Not saved"}: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      const fresh = await act({ brand, action: "list", weekStart: list.weekStart, weeks: list.weeks }).catch(() => null);
      if (fresh) setList(fresh as ReviewList);
      setBusy(null);
    }
  }

  return <div className="review">
    <section className="card review-settings">
      <div>
        <div className="eyebrow">Posts per day</div>
        {networkGroups.map((group) => {
          const first = group[0];
          const week = groupWeekly(group);
          return <div key={first.key} className="review-network">
            <div>
              <b>{NETWORK[first.format.destination] || first.format.destination}</b>{" "}
              {first.account ? <b>{first.account.accountName}</b> : <span className="muted">{first.format.status === "integration" ? first.format.note : "not connected"}</span>}
              {first.account && <span className={week > maxWeek ? "review-warn" : "muted"}> {totals(week)}{week > maxWeek ? ` · over ${maxWeek / 7} a day` : ""}</span>}
            </div>
            {group.map((s) => {
              const editable = Boolean(s.account) && s.format.status !== "integration";
              const wk = Boolean(perWeek[s.key]);
              const value = weeklyOf(s);
              return <label key={s.key} className="review-cadence" title={s.format.note || ""}>
                {s.format.label} <span className={`review-format ${s.format.status}`}>{STATUS[s.format.status]}</span>
                <input type="number" min={0} max={wk ? maxWeek : maxWeek / 7}
                  value={wk ? value : Math.round((value / 7) * 10) / 10} disabled={!editable}
                  onChange={(e) => {
                    const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                    setWeekly({ ...weekly, [s.key]: Math.min(maxWeek, wk ? n : n * 7) });
                  }} />
                <button type="button" className="status-chip review-unit" disabled={!editable}
                  title={wk ? "Switch to posts per day" : "Switch to posts per week"}
                  onClick={() => setPerWeek({ ...perWeek, [s.key]: !wk })}>{wk ? "/wk" : "/day"}</button>
                {editable && <span className="muted">{totals(value)}</span>}
              </label>;
            })}
          </div>;
        })}
        <div className="review-network">
          <div><b>Brand total</b> <span className="muted">{totals(brandWeekly)}</span></div>
          {overCap.length > 0 && <p className="review-warn" style={{ margin: 0 }}>A network takes at most {maxWeek / 7} posts a day across its formats.</p>}
          <button className="status-chip" disabled={!!busy || overCap.length > 0} onClick={saveCadence}>Save</button>
        </div>
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
      const weekApproved = (list.approvedWeeks || []).includes(w.start);
      const tiktokPlanned = w.posts.filter((p) => p.status === "planned" && p.destination === "tiktok");
      const tiktokToReview = tiktokPlanned.length;
      // Clips longer than TikTok allows this account can't be approved; they stay to review until swapped.
      const maxSec = creator?.maxVideoPostDurationSec || null;
      const tiktokTooLong = tiktokPlanned.filter((p) => maxSec && p.asset.durationMs && p.asset.durationMs / 1000 > maxSec);
      const tiktokApprovable = tiktokPlanned.filter((p) => !tiktokTooLong.includes(p));
      // The week under way plans only its remaining days; the planner skips slots already past.
      const underway = w.start <= today;
      return <section key={w.start} className={`review-week${isOpen ? " open" : ""}`}>
        <header onClick={(e) => { if (!(e.target as HTMLElement).closest(".review-actions")) toggle(w.start); }}>
          <button type="button" className="review-week-toggle" aria-expanded={isOpen}>
            <span className="review-chevron" aria-hidden="true">▸</span>
            <h2>Week of {new Date(w.start + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</h2>
          </button>
          {weekApproved && <span className="review-status approved">Week approved</span>}
          <span className="muted">{w.posts.length ? `${approved} approved · ${planned} to review · ${skipped} skipped` : "Nothing planned yet"}</span>
          <div className="review-actions">
            {planned > tiktokToReview && <button className="status-chip" disabled={!!busy}
              title="Approves every network's posts this week; posts added to the week later are approved too. TikTok posts are approved together from the week's TikTok box."
              onClick={() => run("week", { action: "approve-range", from: w.start, to: w.end },
                `Week of ${w.start} approved: every post goes out at its time, including any added later.${tiktokToReview ? ` Approve the ${tiktokToReview} TikTok post${tiktokToReview === 1 ? "" : "s"} in the week's TikTok box.` : ""}`)}>Approve week</button>}
            {w.end >= today && <button className="status-chip" disabled={!!busy || !list.accounts.some((a) => a.active && a.postsPerWeek)}
              title={list.accounts.some((a) => a.active && a.postsPerWeek) ? "" : "Set posts per day first"}
              onClick={() => run("plan", { action: "plan", weekStart: w.start }, `Planning ${underway ? "the rest of " : ""}the week of ${w.start}. Refresh in a minute or two.`)}>
              {underway ? (w.posts.length ? "Replan rest of week" : "Plan rest of week") : (w.posts.length ? "Replan unapproved" : "Plan this week")}
            </button>}
          </div>
        </header>
        {isOpen && tiktokToReview > 0 && <section className="card tiktok-week">
          <div className="eyebrow">TikTok this week · {tiktokToReview} post{tiktokToReview === 1 ? "" : "s"} to approve</div>
          <div className="tiktok-week-thumbs">
            {tiktokPlanned.map((p) => <span key={p.id} title={`${fmtDay(p.scheduledFor)} ${fmtTime(p.scheduledFor)} · ${p.asset.title || p.asset.filename}`}>
              <Thumb asset={p.asset} size={48} /></span>)}
          </div>
          {tiktokTooLong.length > 0 && <p className="review-warn">
            {tiktokTooLong.length} clip{tiktokTooLong.length === 1 ? " is" : "s are"} longer than the {maxSec}s TikTok allows this account. Swap {tiktokTooLong.length === 1 ? "it" : "them"} below; the rest can be approved now.</p>}
          {/* Same TikTok-required controls as a single post (no defaults, preview, consent), applied to every post listed above. */}
          <TiktokCard key={`${w.start}:${tiktokApprovable.length}`} post={{ tiktok: null, status: "planned", asset: { durationMs: null } }}
            creator={creator} creatorError={creatorError} busy={!!busy || !tiktokApprovable.length}
            actionLabel={`Approve all ${tiktokApprovable.length} TikTok post${tiktokApprovable.length === 1 ? "" : "s"} with these settings`}
            onApprove={(settings) => run("tiktok-week", { action: "tiktok-approve", ids: tiktokApprovable.map((p) => p.id), ...settings },
              `Approved ${tiktokApprovable.length} TikTok post${tiktokApprovable.length === 1 ? "" : "s"} for the week of ${w.start} with these settings.`)} />
        </section>}
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
                {p.title && <p className="review-title"><b>{p.title}</b></p>}
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
                {reviewable(p) && p.destination === "tiktok" && p.status !== "skipped" && tiktokOpen === p.id && <TiktokCard post={p} creator={creator} creatorError={creatorError} busy={!!busy}
                  onApprove={async (settings) => { await run(p.id, { action: "tiktok-approve", id: p.id, ...settings }, "Approved for TikTok with these settings."); setTiktokOpen(null); }} />}
                {reviewable(p) && <div className="review-actions">
                  {p.status !== "approved" && p.destination !== "tiktok" && <button className="status-chip" disabled={!!busy} onClick={() => run(p.id, { action: "set-status", ids: [p.id], status: "approved" })}>Approve</button>}
                  {p.destination === "tiktok" && p.status !== "skipped" && <button className="status-chip" disabled={!!busy}
                    onClick={() => setTiktokOpen(tiktokOpen === p.id ? null : p.id)}>{tiktokOpen === p.id ? "Close TikTok settings" : "TikTok settings"}</button>}
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
