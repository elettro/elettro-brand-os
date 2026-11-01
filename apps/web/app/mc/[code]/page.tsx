"use client";
// Elettro MultiCam band page: what a phone opens from the host's QR code (os.elettro.com/mc/<code>). No login.
// Pick the song and your angle, choose clips from the camera roll, and they upload straight to S3 in parts.
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

type Angle = { contributor: string; angle: string; status: string };
type Song = { id: string; title: string; longTake?: boolean; angles: Angle[] };
type Summary = { session: { brandName: string; title: string | null; location: string; sessionDate: string }; angles: string[]; longTakeTitle: string; songs: Song[] };
type Job = { key: string; file: File; songId: string; songTitle: string; angle: string; progress: number; state: "waiting" | "uploading" | "done" | "failed"; error?: string; filename?: string };

const PART_CONCURRENCY = 3;
const PART_RETRIES = 4;

async function band<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/multicam/band", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data as T;
}

function read(key: string) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} }

// PUT one part with progress; resolves to the part's ETag (needs ETag in the bucket's CORS ExposeHeaders).
function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag.replace(/"/g, ""));
      else reject(new Error(xhr.status >= 200 && xhr.status < 300 ? "Upload storage did not return a part receipt" : `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(blob);
  });
}

const fmtMb = (n: number) => (n / 1024 / 1024 >= 1024 ? (n / 1024 ** 3).toFixed(2) + " GB" : Math.max(1, Math.round(n / 1024 / 1024)) + " MB");

export default function MultiCamBand() {
  const params = useParams<{ code: string }>();
  const code = String(params?.code || "");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [fatal, setFatal] = useState("");
  const [name, setName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [songId, setSongId] = useState("");
  const [angle, setAngle] = useState("");
  const [customAngle, setCustomAngle] = useState("");
  const [newSong, setNewSong] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

  const refresh = useCallback(async () => {
    try { setSummary(await band<Summary>({ op: "join", code })); } catch (e) { setFatal(e instanceof Error ? e.message : "This MultiCam link is not valid"); }
  }, [code]);

  useEffect(() => { setName(read("mc_name")); setNameDraft(read("mc_name")); setAngle(read("mc_angle")); refresh(); }, [refresh]);
  useEffect(() => { if (summary && !songId && summary.songs.length) setSongId(read("mc_song_" + code) || summary.songs[summary.songs.length - 1].id); }, [summary, songId, code]);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const update = (key: string, patch: Partial<Job>) => setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function keepAwake(on: boolean) {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
      if (on && nav.wakeLock && !wakeLock.current) wakeLock.current = await nav.wakeLock.request("screen");
      if (!on && wakeLock.current) { await wakeLock.current.release(); wakeLock.current = null; }
    } catch {}
  }

  async function uploadOne(job: Job) {
    update(job.key, { state: "uploading", progress: 0, error: undefined });
    const plan = await band<{ clipId: string; filename: string; partSize: number; partCount: number; parts: { partNumber: number; url: string }[] }>({
      op: "start-upload", code, songId: job.songId, contributor: name, angle: job.angle, filename: job.file.name, size: job.file.size, contentType: job.file.type
    });
    update(job.key, { filename: plan.filename });
    const loaded = new Array(plan.partCount).fill(0);
    const etags: string[] = new Array(plan.partCount);
    let next = 0;
    const worker = async () => {
      while (next < plan.partCount) {
        const i = next++;
        const blob = job.file.slice(i * plan.partSize, Math.min(job.file.size, (i + 1) * plan.partSize));
        for (let attempt = 1; ; attempt++) {
          try {
            etags[i] = await putPart(plan.parts[i].url, blob, (n) => { loaded[i] = n; update(job.key, { progress: loaded.reduce((a, b) => a + b, 0) / job.file.size }); });
            loaded[i] = blob.size;
            break;
          } catch (e) {
            loaded[i] = 0;
            if (attempt >= PART_RETRIES) throw e;
            await new Promise((r) => setTimeout(r, 1500 * attempt * attempt)); // weak signal: wait and retry this part
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, plan.partCount) }, worker));
    } catch (e) {
      band({ op: "abort-upload", code, clipId: plan.clipId }).catch(() => {});
      throw e;
    }
    const done = await band<Summary>({ op: "complete-upload", code, clipId: plan.clipId, parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })) });
    setSummary(done);
    update(job.key, { state: "done", progress: 1 });
  }

  async function run(queue: Job[]) {
    setBusy(true); setNote("");
    await keepAwake(true);
    for (const job of queue) {
      try { await uploadOne(job); } catch (e) { update(job.key, { state: "failed", error: e instanceof Error ? e.message : "Upload failed" }); }
    }
    await keepAwake(false);
    setBusy(false);
  }

  function pickFiles(files: FileList | null) {
    if (!files?.length || !summary) return;
    const finalAngle = (angle === "__custom" ? customAngle : angle).trim();
    if (!songId) { setNote("Pick the song first."); return; }
    if (!finalAngle) { setNote("Pick your angle first."); return; }
    save("mc_angle", angle === "__custom" ? finalAngle : angle); save("mc_song_" + code, songId);
    const songTitle = summary.songs.find((s) => s.id === songId)?.title || "";
    const added = Array.from(files).map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, file, songId, songTitle, angle: finalAngle, progress: 0, state: "waiting" as const }));
    setJobs((all) => [...added, ...all]);
    if (fileInput.current) fileInput.current.value = "";
    run(added);
  }

  async function addSong(title = newSong) {
    if (!title.trim()) return;
    try {
      const r = await band<Summary & { song: { id: string } }>({ op: "band-add-song", code, title });
      setSummary(r); setSongId(r.song.id); if (title === newSong) setNewSong("");
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not add the song"); }
  }

  if (fatal) return <Shell><div className="card center"><div className="big">⚠️</div><h2>{fatal}</h2><p className="mu">Ask the host to show the session QR code again.</p></div></Shell>;
  if (!summary) return <Shell><div className="card center"><p className="mu">Opening the session…</p></div></Shell>;

  const s = summary.session;
  const song = summary.songs.find((x) => x.id === songId);
  const angles = [...new Set([...summary.angles, ...(angle && angle !== "__custom" && !summary.angles.includes(angle) ? [angle] : [])])];

  return (
    <Shell>
      <div className="top">
        <div><div className="brand">{s.brandName}</div><div className="mu small">{s.title || s.location} · {s.sessionDate}</div></div>
        {name && <button className="link" onClick={() => setName("")}>{name} ✎</button>}
      </div>

      {!name ? (
        <div className="card">
          <h2>What&apos;s your name?</h2>
          <p className="mu small">It goes on your clips so the editor knows whose angle is whose. Asked once.</p>
          <input className="input" value={nameDraft} maxLength={40} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" autoFocus />
          <button className="btn" disabled={!nameDraft.trim()} onClick={() => { save("mc_name", nameDraft.trim()); setName(nameDraft.trim()); }}>Continue</button>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="lbl">Song</div>
            <div className="chips">
              {summary.songs.filter((x) => !x.longTake).map((x) => <button key={x.id} className={"chip" + (x.id === songId ? " on" : "")} onClick={() => setSongId(x.id)}>{x.title}</button>)}
              <button className={"chip" + (song?.longTake ? " on" : "")} onClick={() => { const lt = summary.songs.find((x) => x.longTake); if (lt) setSongId(lt.id); else addSong(summary.longTakeTitle); }}>Several songs in one take</button>
            </div>
            {song?.longTake && <p className="mu small">One file that runs through several songs is fine. The edit finds each song in it by sound.</p>}
            <div className="row"><input className="input" value={newSong} maxLength={80} onChange={(e) => setNewSong(e.target.value)} placeholder="+ New song" /><button className="btn sm" disabled={!newSong.trim()} onClick={() => addSong()}>Add</button></div>

            <div className="lbl">Your angle</div>
            <div className="chips">
              {angles.map((a) => <button key={a} className={"chip" + (a === angle ? " onm" : "")} onClick={() => setAngle(a)}>{a}</button>)}
              <button className={"chip" + (angle === "__custom" ? " onm" : "")} onClick={() => setAngle("__custom")}>Other…</button>
            </div>
            {angle === "__custom" && <input className="input" value={customAngle} maxLength={30} onChange={(e) => setCustomAngle(e.target.value)} placeholder="Name your angle (e.g. Left of stage)" />}
          </div>

          <input ref={fileInput} type="file" accept="video/*,audio/*" multiple hidden onChange={(e) => pickFiles(e.target.files)} />
          <button className="cta" onClick={() => fileInput.current?.click()}>
            + Add your clip{song ? <small>for “{song.title}”</small> : <small>pick a song above</small>}
          </button>
          {note && <p className="warn">{note}</p>}
          {busy && <p className="mu small center">Keep this page open until it says ✓. Weak signal is fine; it retries.</p>}

          {jobs.length > 0 && (
            <div className="card">
              {jobs.map((j) => (
                <div key={j.key} className="job">
                  <div className="jobtop"><span className="ell">{j.songTitle} · {j.angle}</span>
                    <span className={j.state === "done" ? "ok" : j.state === "failed" ? "bad" : "mu"}>{j.state === "done" ? "✓ Saved" : j.state === "failed" ? "Failed" : j.state === "waiting" ? "Waiting" : Math.floor(j.progress * 100) + "%"}</span></div>
                  <div className="prog"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
                  <div className="mu tiny ell">{j.file.name} · {fmtMb(j.file.size)}</div>
                  {j.state === "failed" && <div className="bad tiny">{j.error} <button className="link" disabled={busy} onClick={() => run([j])}>Try again</button></div>}
                </div>
              ))}
            </div>
          )}

          {song && (
            <div className="card">
              <div className="lbl">In for “{song.title}”</div>
              {song.angles.length ? song.angles.map((a, i) => (
                <div key={i} className="ang"><span>{a.angle} · {a.contributor}</span><span className={a.status === "uploaded" ? "ok" : "mu"}>{a.status === "uploaded" ? "✓" : "…"}</span></div>
              )) : <p className="mu small">No clips yet. Be the first.</p>}
            </div>
          )}
          <p className="mu tiny center">Film landscape. Start before the count-in. Partial shots count.</p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mc">
      <style>{`
        .mc{min-height:100vh;background:#141a23;color:#f3f6f9;font-family:Manrope,system-ui,sans-serif;padding:16px 16px 40px;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
        .mc .top{display:flex;justify-content:space-between;align-items:center;border:2px solid #6fd8e8;border-radius:18px;padding:10px 14px}
        .mc .brand{font-family:'Space Grotesk',sans-serif;font-weight:700;color:#6fd8e8;font-size:18px}
        .mc .card{background:#1b2430;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}
        .mc .center{text-align:center;align-items:center}
        .mc h2{margin:0;font-size:20px}
        .mc .big{font-size:40px}
        .mc .mu{color:#a9b6c4}.mc .small{font-size:13px}.mc .tiny{font-size:12px}
        .mc .lbl{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#a9b6c4;margin-top:4px}
        .mc .chips{display:flex;flex-wrap:wrap;gap:8px}
        .mc .chip{border:0;border-radius:999px;padding:10px 14px;font-size:15px;background:#2a3544;color:#f3f6f9}
        .mc .chip.on{background:#6fd8e8;color:#0e131a;font-weight:700}
        .mc .chip.onm{background:#ee4b9b;color:#fff;font-weight:700}
        .mc .input{width:100%;box-sizing:border-box;border-radius:12px;border:1px solid #3a4757;background:#0e131a;color:#f3f6f9;padding:12px;font-size:16px}
        .mc .row{display:flex;gap:8px}
        .mc .btn{border:0;border-radius:12px;padding:12px 16px;font-size:16px;font-weight:700;background:#6fd8e8;color:#0e131a}
        .mc .btn.sm{padding:10px 14px}
        .mc .btn:disabled{opacity:.4}
        .mc .cta{border:0;border-radius:20px;padding:22px 12px;font-size:22px;font-weight:800;color:#fff;background:linear-gradient(135deg,#ee4b9b,#ff7a5a);box-shadow:0 8px 22px rgba(238,75,155,.35)}
        .mc .cta small{display:block;font-size:14px;font-weight:500;opacity:.9;margin-top:4px}
        .mc .link{background:none;border:0;color:#6fd8e8;font-size:14px;text-decoration:underline;padding:0}
        .mc .job{display:flex;flex-direction:column;gap:5px;padding:6px 0;border-bottom:1px solid #2a3544}
        .mc .jobtop{display:flex;justify-content:space-between;gap:8px;font-size:15px;font-weight:600}
        .mc .ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .mc .prog{height:8px;background:#2a3544;border-radius:4px;overflow:hidden}
        .mc .prog i{display:block;height:100%;background:linear-gradient(90deg,#6fd8e8,#ee4b9b);transition:width .3s}
        .mc .ang{display:flex;justify-content:space-between;font-size:15px;padding:4px 0}
        .mc .ok{color:#6fd8e8;font-weight:700}.mc .bad{color:#ff7a8a}.mc .warn{color:#f5e32a;text-align:center;margin:0}
      `}</style>
      {children}
    </main>
  );
}
