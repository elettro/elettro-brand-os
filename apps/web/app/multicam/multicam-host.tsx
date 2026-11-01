"use client";
// Elettro MultiCam host console: start a session, show its QR code, watch the angles arrive, tap Make it.
import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { McSessionDetail, McSessionRow } from "@/lib/multicam";

async function host<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/multicam/host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data as T;
}

function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const fmtSize = (n: number) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + " GB" : Math.max(1, Math.round(n / 1024 / 1024)) + " MB");
const MAKE_LABEL: Record<string, string> = { collecting: "Make it", requested: "Requested ✓", rendering: "Rendering…", done: "Done ✓" };

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
                      <button className={"mcx-make" + (song.status !== "collecting" ? " done" : "")} disabled={busy || !(uploaded.length || longTakes) || song.status !== "collecting"} onClick={() => op({ op: "request-make", songId: song.id })}>
                        ✦ {MAKE_LABEL[song.status] || song.status}
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
                    {song.status === "requested" && <p className="mcx-mu small">Requested. The automatic edit is the next build phase; until then the editor (Claude) picks it up from here.</p>}
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
.mcx-addsong{flex-direction:row}
.mcx-addsong .mcx-input{flex:1}
`;
