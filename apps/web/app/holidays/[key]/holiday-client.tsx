"use client";

import { useState } from "react";
import type { HolidayDraft, HolidayList, ReviewAsset } from "@/lib/planner-review";
import { AssetThumb as Thumb } from "@/components/asset-thumb";

const NETWORK: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon" };
const CAPTION_MAX = 280;

async function call(body: Record<string, unknown>) {
  const response = await fetch("/api/planner/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await response.json().catch(() => ({ ok: false, error: "No answer" })) as { ok: boolean; error?: string; [k: string]: unknown };
}
const when = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function HolidayClient({ holiday, holidayName, single, initial, names }: { holiday: string; holidayName: string; single: boolean; initial: HolidayList[]; names: Record<string, string> }) {
  const [lists, setLists] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState("");

  async function refresh(brand: string) {
    const data = await call({ brand, action: "holiday-list", key: holiday }) as unknown as HolidayList;
    if (data.ok) setLists((cur) => cur.map((l) => (l.brand === brand ? data : l)));
  }
  async function act(brand: string, action: string, extra: Record<string, unknown>, id: string) {
    setBusy(id); setNote(null);
    const r = await call({ brand, action, key: holiday, ...extra });
    if (!r.ok) setNote(r.error || "That did not work");
    await refresh(brand);
    setBusy(null);
    return r;
  }
  async function approve(brand: string, draftIds: string[], id: string) {
    const r = await act(brand, "holiday-approve", { draftIds }, id);
    if (r.ok) {
      const waiting = (r.waitingForImage as string[] | undefined)?.length || 0;
      setNote(`${names[brand] || brand}: ${r.approved} approved, ${r.posts} posts scheduled${waiting ? `, ${waiting} waiting for a picture` : ""}.`);
    }
  }
  async function approveAll() {
    setBusy("all"); setNote(null);
    let approved = 0, posts = 0;
    for (const l of lists) {
      const ids = l.drafts.filter((d) => d.status === "draft" && d.imageReady).map((d) => d.id);
      if (!ids.length) continue;
      const r = await call({ brand: l.brand, action: "holiday-approve", key: holiday, draftIds: ids });
      if (r.ok) { approved += Number(r.approved) || 0; posts += Number(r.posts) || 0; }
      await refresh(l.brand);
    }
    const waiting = lists.reduce((n, l) => n + l.drafts.filter((d) => d.status === "draft" && !d.imageReady).length, 0);
    setNote(`Approved ${approved} drafts as ${posts} scheduled posts${waiting ? `; ${waiting} still waiting for a picture` : ""}.`);
    setBusy(null);
  }

  const pending = lists.reduce((n, l) => n + l.drafts.filter((d) => d.status === "draft" && d.imageReady).length, 0);
  const approvedRows = lists.flatMap((l) => l.drafts.filter((d) => d.status === "approved").map((d) => ({ l, d })));

  function renderDraft(d: HolidayDraft, l: HolidayList) {
    const id = `${l.brand}:${d.id}`;
    const isBusy = busy === id;
    const isEditing = editing === id, isSwapping = swapping === id;
    const locked = d.status === "approved";
    return <div key={d.id} className={`hol-card ${d.status}`}>
      <div className="hol-media">{d.asset ? <Thumb asset={d.asset as ReviewAsset} size={220} /> : <div className="muted">Picture not added yet ({d.imageName})</div>}</div>
      {d.status !== "draft" && <span className="hol-tag">{d.status === "approved" ? "Approved" : "Skipped"}</span>}
      {isEditing ? <>
        <textarea value={caption} maxLength={CAPTION_MAX} onChange={(e) => setCaption(e.target.value)} aria-label="Caption" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Hashtags" placeholder="Hashtags, separated by spaces" />
        <div className="hol-actions">
          <button className="cal-btn" disabled={isBusy || !caption.trim()} onClick={async () => { const r = await act(l.brand, "holiday-edit", { draftId: d.id, caption, hashtags: tags.split(/[\s,]+/).filter(Boolean) }, id); if (r.ok) setEditing(null); }}>Save</button>
          <button className="cal-btn" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </> : <>
        <div>{d.caption}</div>
        {d.hashtags.length > 0 && <div className="muted">{d.hashtags.map((h) => `#${h}`).join(" ")}</div>}
      </>}
      {locked && d.posts.length > 0 && <div className="muted">{d.posts.map((p) => `${NETWORK[p.destination] || p.destination} ${when(p.scheduledFor, l.timeZone)}`).join(" · ")}</div>}
      {isSwapping && <div className="hol-swap">{l.choices.filter((c) => c.id !== d.asset?.id).map((c) =>
        <button key={c.id} aria-label={`Use ${c.filename}`} onClick={async () => { const r = await act(l.brand, "holiday-swap", { draftId: d.id, assetId: c.id }, id); if (r.ok) setSwapping(null); }}><Thumb asset={c} size={80} /></button>)}
        {l.choices.length === 0 && <span className="muted">No other {holidayName} pictures in this brand yet.</span>}</div>}
      {!locked && !isEditing && <div className="hol-actions">
        {d.status === "skipped"
          ? <button className="cal-btn" disabled={isBusy} onClick={() => void act(l.brand, "holiday-skip", { draftId: d.id, skipped: false }, id)}>Bring back</button>
          : <>
            <button className="cal-btn" disabled={isBusy || !d.imageReady || l.destinations.length === 0} title={!d.imageReady ? "Add the picture first" : undefined} onClick={() => void approve(l.brand, [d.id], id)}>Approve</button>
            <button className="cal-btn" disabled={isBusy} onClick={() => { setCaption(d.caption); setTags(d.hashtags.join(" ")); setEditing(id); setSwapping(null); }}>Edit</button>
            <button className="cal-btn" disabled={isBusy} onClick={() => setSwapping(isSwapping ? null : id)}>Swap</button>
            <button className="cal-btn" disabled={isBusy} onClick={() => void act(l.brand, "holiday-skip", { draftId: d.id }, id)}>Skip</button>
          </>}
      </div>}
    </div>;
  }

  return <>
    <div className="hol-bar">
      {!single && <button className="hol-big" disabled={busy !== null || pending === 0} onClick={() => void approveAll()}>{busy === "all" ? "Approving…" : `Approve all (${pending})`}</button>}
      {note && <span role="status">{note}</span>}
    </div>
    {lists.map((l) => <section className="hol-brand" key={l.brand}>
      <h2>{names[l.brand] || l.brand}</h2>
      <div className="muted">{holidayName} · {l.destinations.length ? l.destinations.map((n) => NETWORK[n] || n).join(", ") : "no connected photo network yet"}</div>
      <div className="hol-grid">
        {l.drafts.map((d) => renderDraft(d, l))}
      </div>
    </section>)}
    {!single && <section className="hol-approved">
      <h2>Approved</h2>
      {approvedRows.length === 0 ? <p className="muted">Nothing approved yet.</p> : <ul>
        {approvedRows.map(({ l, d }) => <li key={`${l.brand}-${d.id}`}><strong>{names[l.brand] || l.brand}</strong>: {d.caption.slice(0, 70)}{d.caption.length > 70 ? "…" : ""}{" "}
          <span className="muted">{d.posts.map((p) => `${NETWORK[p.destination] || p.destination} ${when(p.scheduledFor, l.timeZone)}`).join(" · ")}</span></li>)}
      </ul>}
    </section>}
  </>;
}
