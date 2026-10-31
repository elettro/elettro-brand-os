"use client";

import { useEffect, useState } from "react";

// Write a LinkedIn text post, link post or poll by hand. It is saved as "to review" for the chosen time; the usual Approve on its
// card on Review sends it. Limits are LinkedIn's (poll question 140, options 30, 2-4 options); the server checks them again.
// Lives on Connections, in each connected LinkedIn brand's card; saves through the same-origin review proxy.
const TZ = "America/New_York";
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
type Kind = "text" | "link" | "poll";
const DURATIONS: Array<[string, string]> = [["ONE_DAY", "1 day"], ["THREE_DAYS", "3 days"], ["SEVEN_DAYS", "7 days"], ["FOURTEEN_DAYS", "14 days"]];

export function LinkedInWriter({ brand, accountName }: { brand: string; accountName: string }) {
  const timeZone = TZ;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assetId, setAssetId] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [duration, setDuration] = useState("SEVEN_DAYS");
  const [when, setWhen] = useState("");
  // Tomorrow 10:00 in the planner's zone; set after mount so server and browser agree on first render.
  useEffect(() => { setWhen(localInput(new Date(Date.now() + 24 * 3600_000).toISOString(), TZ).replace(/T\d\d:\d\d$/, "T10:00")); }, []);

  async function save() {
    if (!when) { setNotice({ ok: false, text: "Pick a time first." }); return; }
    const body: Record<string, unknown> = { brand, action: "queue-custom", kind, text, scheduledFor: instantOf(when, TZ) };
    if (kind === "link") Object.assign(body, { url, title, description, ...(assetId.trim() ? { assetId: assetId.trim() } : {}) });
    if (kind === "poll") Object.assign(body, { question, options, duration });
    setBusy(true);
    setNotice(null);
    let saved = false;
    try {
      const response = await fetch("/api/planner/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
      saved = true;
      setNotice({ ok: true, text: "Saved as to review." });
    } catch (error) {
      setNotice({ ok: false, text: `Not saved: ${error instanceof Error ? error.message : "unknown error"}` });
    } finally {
      setBusy(false);
    }
    if (saved) { setText(""); setUrl(""); setTitle(""); setDescription(""); setQuestion(""); setOptions(["", "", "", ""]); }
  }

  return <section className="card" style={{ margin: "16px 0" }} id={`li-write-${brand}`}>
    <div className="eyebrow">LinkedIn · {accountName}</div>
    <h2 style={{ margin: "4px 0 8px" }}>Write a LinkedIn post</h2>
    <p className="muted" style={{ margin: "0 0 12px" }}>
      A text post, a link, or a poll. It is saved as <b>to review</b> at the time below ({timeZone}); approve it on its card on the <a href={`/review?brand=${brand}`}>Review page</a> to send it.
    </p>
    <div className="connect-row" style={{ marginBottom: 12 }}>
      {(["text", "link", "poll"] as Kind[]).map((k) => <button key={k} type="button" className="status-chip" aria-pressed={kind === k}
        style={kind === k ? { fontWeight: 700, outline: "2px solid currentColor" } : undefined} onClick={() => setKind(k)}>
        {k === "text" ? "Text post" : k === "link" ? "Link post" : "Poll"}</button>)}
    </div>

    <label className="muted" htmlFor="li-w-text">{kind === "poll" ? "Text above the poll (optional)" : kind === "link" ? "Text above the link" : "Post text"}</label>
    <textarea id="li-w-text" rows={kind === "text" ? 6 : 3} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%" }} />

    {kind === "link" && <>
      <label className="muted" htmlFor="li-w-url">Link</label>
      <input id="li-w-url" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: "100%" }} />
      <label className="muted" htmlFor="li-w-title">Card title (up to 200 characters)</label>
      <input id="li-w-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
      <label className="muted" htmlFor="li-w-desc">Card description (optional, up to 255)</label>
      <input id="li-w-desc" maxLength={255} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%" }} />
      <label className="muted" htmlFor="li-w-asset">Card image: asset ID (optional; blank uses the brand&apos;s latest approved image)</label>
      <input id="li-w-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)} style={{ width: "100%" }} />
    </>}

    {kind === "poll" && <>
      <label className="muted" htmlFor="li-w-q">Question ({question.length}/140)</label>
      <input id="li-w-q" maxLength={140} value={question} onChange={(e) => setQuestion(e.target.value)} style={{ width: "100%" }} />
      {options.map((o, i) => <div key={i}>
        <label className="muted" htmlFor={`li-w-o${i}`}>Option {i + 1}{i < 2 ? "" : " (optional)"} ({o.length}/30)</label>
        <input id={`li-w-o${i}`} maxLength={30} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: "100%" }} />
      </div>)}
      <label className="muted" htmlFor="li-w-dur">Poll stays open</label>
      <select id="li-w-dur" value={duration} onChange={(e) => setDuration(e.target.value)}>
        {DURATIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    </>}

    <label className="muted" htmlFor="li-w-when" style={{ display: "block", marginTop: 12 }}>Post at ({timeZone})</label>
    <input id="li-w-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
    <div style={{ marginTop: 12 }}>
      <button type="button" className="status-chip" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save for review"}</button>
      {notice && <p role="status" className={`post-result ${notice.ok ? "ok" : "bad"}`}>{notice.ok ? <><b>✓ {notice.text}</b> Approve it on the <a href={`/review?brand=${brand}`}>Review page</a> to send it.</> : <><b>✗</b> {notice.text}</>}</p>}
    </div>
  </section>;
}
