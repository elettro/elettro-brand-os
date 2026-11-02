"use client";
// Elettro MultiCam host console: start a session, show its QR code, watch the angles arrive, then Make it with a
// style prompt and the outputs to render.
import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { McOutputs, McSessionDetail, McSessionRow, McSong } from "@/lib/multicam";

async function host<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/multicam/host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data as T;
}

function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const fmtSize = (n: number) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + " GB" : Math.max(1, Math.round(n / 1024 / 1024)) + " MB");
const MAKE_LABEL: Record<string, string> = { collecting: "Make it", requested: "Requested ✓", rendering: "Rendering…", done: "Done ✓" };
// Kept in step with makeRequest in services/dev-api-lambda/multicam.mjs.
const DEFAULT_OUTPUTS: McOutputs = { full: true, shorts: 3, stills: true, quality: "1080p" };
const MAX_STYLE_CHARS = 1000;
const QUALITY_LABEL: Record<McOutputs["quality"], string> = { "1080p": "1080p (fast)", "1080p+4k": "1080p now, 4K after", "4k": "4K only" };
const STYLE_IDEAS = [
  "Warm surf vibe, smooth dissolves, mirror floor, ocean B-roll in the solo. Guitar on the solo, drummer on the fills.",
  "Psychedelic 60s: aura and soul-echo ghosts, floor portal on the bridge. Smooth dissolves, no pulsing.",
  "Clean and simple. Stay on the singer, cut to the band on the chorus, no effects, no B-roll."
];
function outputsText(o: McOutputs | null) {
  if (!o) return "";
  return [o.full && "16:9 full video", o.shorts ? `${o.shorts} short${o.shorts > 1 ? "s" : ""} 9:16` : "", o.stills && "stills", QUALITY_LABEL[o.quality]].filter(Boolean).join(" · ");
}

export function MultiCamHost({ brands, publicOrigin }: { brands: string[]; publicOrigin: string }) {
  const [brand, setBrand] = useState(brands[0]);
  const [sessions, setSessions] = useState<McSessionRow[]>([]);
  const [detail, setDetail] = useState<McSessionDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState("Studio One");
  const [date, setDate] = useState(today());
  const [title, setTitle] = useState("");
  const [songs, setSongs] = useState("");
  const [newSong, setNewSong] = useState("");
  const [copied, setCopied] = useState(false);
  // The Make-it panel: one song at a time.
  const [makeFor, setMakeFor] = useState<string | null>(null);
  const [style, setStyle] = useState("");
  const [outputs, setOutputs] = useState<McOutputs>(DEFAULT_OUTPUTS);

  const act = useCallback(async <T,>(body: Record<string, unknown>) => {
    setError("");
    try { return await host<T>({ brand, ...body }); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); return null; }
  }, [brand]);

  const loadList = useCallback(async () => { const r = await act<{ sessions: McSessionRow[] }>({ op: "list-sessions" }); if (r) setSessions(r.sessions); }, [act]);
  const open = useCallback(async (sessionId: string) => { const r = await act<McSessionDetail>({ op: "get-session", sessionId }); if (r) setDetail(r); }, [act]);

  useEffect(() => { setDetail(null); loadList(); }, [loadList]);
  // While a session is open, refresh every 5 s so arriving angles show up.
  useEffect(() => {
    if (!detail?.session.open) return;
    const id = detail.session.id;
    const t = setInterval(() => { host<McSessionDetail>({ brand, op: "get-session", sessionId: id }).then(setDetail).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [detail?.session.id, detail?.session.open, brand]);

  const link = detail ? `${publicOrigin}/mc/${detail.session.code}` : "";
  const qrSvg = useMemo(() => {
    if (!link) return "";
    const q = qrcode(0, "M"); q.addData(link); q.make();
    return q.createSvgTag({ cellSize: 1, margin: 2, scalable: true });
  }, [link]);

  async function start() {
    setBusy(true);
    const r = await act<McSessionDetail>({ op: "create-session", location, sessionDate: date, title: title || undefined, songs: songs.split("\n").map((s) => s.trim()).filter(Boolean) });
    if (r) { setDetail(r); setTitle(""); setSongs(""); loadList(); }
    setBusy(false);
  }
  async function op(body: Record<string, unknown>) {
    if (!detail) return;
    setBusy(true);
    const r = await act<McSessionDetail>({ sessionId: detail.session.id, ...body });
    if (r) { setDetail(r); loadList(); }
    setBusy(false);
  }
  function openMake(song: McSong) {
    // Start from this song's last request, else the newest prompt in this session, so a set keeps one look.
    const latest = detail?.songs.filter((s) => s.makeStyle || s.makeOutputs).sort((a, b) => String(b.makeRequestedAt).localeCompare(String(a.makeRequestedAt)))[0];
    setStyle(song.makeStyle ?? latest?.makeStyle ?? "");
    setOutputs(song.makeOutputs ?? latest?.makeOutputs ?? DEFAULT_OUTPUTS);
    setMakeFor(song.id);
  }
  async function sendMake(songId: string) {
    await op({ op: "request-make", songId, style, outputs });
    setMakeFor(null);
  }
  const nothingToMake = !outputs.full && !outputs.shorts && !outputs.stills;

  async function download(clipId: string) {
    if (!detail) return;
    const r = await act<{ url: string }>({ op: "clip-download", sessionId: detail.session.id, clipId });
    if (r?.url) window.location.href = r.url;
  }

  return (
    <div className="mcx">
      <style>{CSS}</style>
      <div className="mcx-head">
        <div><h1>MultiCam</h1><p className="mcx-mu">Every phone in the room, one multi-cam video. Start a session, show the QR, everyone uploads, tap Make it.</p></div>
        <select className="mcx-input mcx-brand" value={brand} onChange={(e) => setBrand(e.target.value)}>{brands.map((b) => <option key={b} value={b}>{b}</option>)}</select>
      </div>
      {error && <p className="mcx-err">{error}</p>}

      <div className="mcx-grid">
        <aside className="mcx-col">
          <section className="mcx-card">
            <h2>Start a session</h2>
            <label className="mcx-lbl">Where<input className="mcx-input" value={location} maxLength={60} onChange={(e) => setLocation(e.target.value)} /></label>
            <label className="mcx-lbl">Date<input className="mcx-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="mcx-lbl">Title (optional)<input className="mcx-input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Stashbox Does Dylan rehearsal" /></label>
            <label className="mcx-lbl">Songs (optional, one per line; the band can add more)<textarea className="mcx-input" rows={4} value={songs} onChange={(e) => setSongs(e.target.value)} /></label>
            <button className="mcx-btn" disabled={busy || !location.trim() || !date} onClick={start}>Start session &amp; show QR</button>
          </section>
          <section className="mcx-card">
            <h2>Sessions</h2>
            {sessions.length === 0 && <p className="mcx-mu">None yet.</p>}
            {sessions.map((s) => (
              <button key={s.id} className={"mcx-row" + (detail?.session.id === s.id ? " on" : "")} onClick={() => open(s.id)}>
                <span><b>{s.sessionDate}</b> · {s.title || s.location}</span>
                <span className="mcx-mu">{s.clipCount} clips · {s.open ? <span className="mcx-ok">open</span> : "ended"}</span>
              </button>
            ))}
          </section>
        </aside>

        <section className="mcx-col">
          {!detail ? <div className="mcx-card mcx-mu">Start a session or pick one on the left.</div> : (
            <>
              <div className="mcx-card mcx-qrcard">
                <div className="mcx-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                <div className="mcx-qrinfo">
                  <h2>{detail.session.brandName} · {detail.session.title || detail.session.location}</h2>
                  <p className="mcx-mu">{detail.session.sessionDate} · {detail.session.open ? <>open until {new Date(detail.session.expiresAt).toLocaleString()}</> : <b>ended — the QR no longer works</b>}</p>
                  <p className="mcx-code">{link}</p>
                  <div className="mcx-actions">
                    <button className="mcx-btn ghost" onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied ✓" : "Copy link"}</button>
                    {detail.session.open
                      ? <button className="mcx-btn ghost" disabled={busy} onClick={() => op({ op: "end-session" })}>End session</button>
                      : <button className="mcx-btn ghost" disabled={busy} onClick={() => op({ op: "reopen-session" })}>Reopen</button>}
                  </div>
                  <p className="mcx-mu small">Only you can open this page. Anyone who scans the QR can upload until the session ends. Delivery folder: <code>{detail.session.deliveryFolder}</code></p>
                </div>
              </div>

              {detail.songs.map((song) => {
                const uploaded = song.clips.filter((c) => c.status === "uploaded");
                const longTakes = detail.songs.filter((s) => s.longTake).flatMap((s) => s.clips).filter((c) => c.status === "uploaded").length;
                return (
                  <div key={song.id} className="mcx-card">
                    <div className="mcx-songhead">
                      <h2>{song.title}</h2>
                      <span className="mcx-mu">{uploaded.length} in{song.clips.length > uploaded.length ? ` · ${song.clips.length - uploaded.length} uploading` : ""}{!song.longTake && longTakes ? ` · +${longTakes} long take${longTakes > 1 ? "s" : ""}` : ""}</span>
                      {song.longTake ? <span className="mcx-mu small">Used by every song; the edit finds each song in these by sound.</span> :
                      <button className={"mcx-make" + (song.status !== "collecting" ? " done" : "")} disabled={busy || !(uploaded.length || longTakes) || (song.status !== "collecting" && song.status !== "requested") || makeFor === song.id} onClick={() => openMake(song)}>
                        ✦ {song.status === "requested" ? "Requested ✓ · change" : MAKE_LABEL[song.status] || song.status}
                      </button>}
                    </div>
                    {song.clips.length === 0 && <p className="mcx-mu">Waiting for the first clip…</p>}
                    {song.clips.map((c) => (
                      <div key={c.id} className="mcx-clip">
                        <span><b>{c.angle}</b> · {c.contributor}</span>
                        <span className="mcx-mu">{fmtSize(c.sizeBytes)}</span>
                        {c.status === "uploaded" ? <button className="mcx-link" onClick={() => download(c.id)}>Download</button> : <span className="mcx-mu">uploading…</span>}
                      </div>
                    ))}
                    {makeFor === song.id && (
                      <div className="mcx-makepanel">
                        <label className="mcx-lbl">Style prompt: the look, transitions, effects, B-roll, who to feature
                          <textarea className="mcx-input" rows={4} maxLength={MAX_STYLE_CHARS} value={style} onChange={(e) => setStyle(e.target.value)} placeholder={STYLE_IDEAS[0]} autoFocus />
                        </label>
                        <div className="mcx-ideas">{STYLE_IDEAS.map((idea) => <button key={idea} type="button" className="mcx-chip" onClick={() => setStyle(idea)}>{idea.split(/[,:.]/)[0]}</button>)}<span className="mcx-mu small">{style.length}/{MAX_STYLE_CHARS}</span></div>
                        <div className="mcx-outs">
                          <label><input type="checkbox" checked={outputs.full} onChange={(e) => setOutputs({ ...outputs, full: e.target.checked })} /> 16:9 full video</label>
                          <label>Shorts 9:16 <select className="mcx-input mcx-small" value={outputs.shorts} onChange={(e) => setOutputs({ ...outputs, shorts: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                          <label><input type="checkbox" checked={outputs.stills} onChange={(e) => setOutputs({ ...outputs, stills: e.target.checked })} /> Stills &amp; thumbnails</label>
                        </div>
                        <div className="mcx-outs">{(Object.keys(QUALITY_LABEL) as McOutputs["quality"][]).map((q) => (
                          <label key={q}><input type="radio" name={"q-" + song.id} checked={outputs.quality === q} onChange={() => setOutputs({ ...outputs, quality: q })} /> {QUALITY_LABEL[q]}</label>
                        ))}</div>
                        <div className="mcx-actions">
                          <button className="mcx-make" disabled={busy || nothingToMake} onClick={() => sendMake(song.id)}>✦ {song.status === "requested" ? "Update request" : "Make it"}</button>
                          <button className="mcx-btn ghost" onClick={() => setMakeFor(null)}>Cancel</button>
                          {nothingToMake && <span className="mcx-err small">Pick at least one thing to make.</span>}
                        </div>
                      </div>
                    )}
                    {song.status === "requested" && makeFor !== song.id && (
                      <div className="mcx-req">
                        {song.makeStyle ? <p className="mcx-style">“{song.makeStyle}”</p> : <p className="mcx-mu small">No style prompt (house style).</p>}
                        <p className="mcx-mu small">{outputsText(song.makeOutputs)}</p>
                        <p className="mcx-mu small">Requested. The automatic render is the next build phase; until then the editor (Claude) picks it up from here, style prompt included.</p>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="mcx-card mcx-addsong">
                <input className="mcx-input" value={newSong} maxLength={80} onChange={(e) => setNewSong(e.target.value)} placeholder="Add a song" />
                <button className="mcx-btn" disabled={busy || !newSong.trim()} onClick={async () => { await op({ op: "add-song", title: newSong }); setNewSong(""); }}>Add</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const CSS = `
.mcx{display:flex;flex-direction:column;gap:16px}
.mcx h1{margin:0;font-family:'Space Grotesk',sans-serif}
.mcx h2{margin:0;font-size:17px}
.mcx-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.mcx-mu{color:var(--muted)}.mcx .small{font-size:13px}
.mcx-err{color:var(--danger)}
.mcx-ok{color:var(--success)}
.mcx-grid{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:16px}
@media (max-width:860px){.mcx-grid{grid-template-columns:1fr}}
.mcx-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.mcx-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
.mcx-lbl{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.mcx-input{background:var(--panel-soft);border:1px solid var(--line);border-radius:10px;color:var(--text);padding:9px 10px;font:inherit}
.mcx-brand{width:auto}
.mcx-btn{background:var(--accent);color:#04121a;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}
.mcx-btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.mcx-btn:disabled,.mcx-make:disabled{opacity:.45;cursor:default}
.mcx-row{display:flex;justify-content:space-between;gap:8px;background:transparent;border:1px solid var(--line);border-radius:10px;padding:9px 10px;color:var(--text);text-align:left;cursor:pointer;font:inherit}
.mcx-row.on{border-color:var(--accent);background:var(--accent-soft)}
.mcx-qrcard{flex-direction:row;flex-wrap:wrap;align-items:center;gap:18px}
.mcx-qr{width:220px;height:220px;background:#fff;border-radius:12px;padding:8px;flex:none}
.mcx-qr svg{width:100%;height:100%}
.mcx-qrinfo{flex:1;min-width:240px;display:flex;flex-direction:column;gap:8px}
.mcx-code{font-family:monospace;word-break:break-all;margin:0}
.mcx-actions{display:flex;gap:8px;flex-wrap:wrap}
.mcx-songhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mcx-songhead h2{flex:1}
.mcx-make{border:0;border-radius:12px;padding:10px 18px;font-weight:800;color:#fff;background:linear-gradient(135deg,#ee4b9b,#ff7a5a);cursor:pointer}
.mcx-make.done{background:var(--accent-soft);color:var(--accent)}
.mcx-clip{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;border-top:1px solid var(--line);padding-top:8px}
.mcx-link{background:none;border:0;color:var(--accent);cursor:pointer;text-decoration:underline;font:inherit}
.mcx-makepanel,.mcx-req{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:10px}
.mcx-ideas{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mcx-chip{background:var(--panel-soft);border:1px solid var(--line);border-radius:99px;color:var(--text);padding:5px 11px;cursor:pointer;font:inherit;font-size:13px}
.mcx-outs{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;font-size:14px}
.mcx-outs label{display:flex;align-items:center;gap:6px}
.mcx-small{padding:4px 6px}
.mcx-style{margin:0;font-style:italic;white-space:pre-wrap}
.mcx-req p{margin:0}
.mcx-addsong{flex-direction:row}
.mcx-addsong .mcx-input{flex:1}
`;
