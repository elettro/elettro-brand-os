"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import qrcode from "qrcode-generator";

type Row = { id: string; name: string; slug: string; mode: string; isMain?: boolean; url?: string; setId?: string; actionId?: string; address: string; destination: string };
type Option = { id: string; name: string };
type Mode = "scanner" | "experience" | "url";

const MODES: Array<{ id: Mode; title: string; hint: string }> = [
  { id: "scanner", title: "Scanner", hint: "Open the camera with a scan set" },
  { id: "experience", title: "One experience", hint: "Open straight into one action" },
  { id: "url", title: "Web link", hint: "Redirect to a web address (https only)" }
];
const MODE_NAME: Record<string, string> = { scanner: "Scanner", experience: "One experience", url: "Web link" };

function code(address: string) {
  const q = qrcode(0, "M");
  q.addData(address);
  q.make();
  return q;
}

export function QrManager({ brand, qrs, sets, actions }: { brand: string; qrs: Row[]; sets: Option[]; actions: Option[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string>(qrs.find((q) => q.isMain)?.id || qrs[0]?.id || "new");
  const current = qrs.find((q) => q.id === selected) || null;
  const [mode, setMode] = useState<Mode>((current?.mode as Mode) || "url");
  const [setId, setSetId] = useState(current?.setId || sets[0]?.id || "");
  const [actionId, setActionId] = useState(current?.actionId || actions[0]?.id || "");
  const [url, setUrl] = useState(current?.url || "https://");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function pick(id: string) {
    const q = qrs.find((x) => x.id === id) || null;
    setSelected(id);
    setMessage("");
    if (q) {
      setMode(q.mode as Mode);
      setSetId(q.setId || sets[0]?.id || "");
      setActionId(q.actionId || actions[0]?.id || "");
      setUrl(q.url || "https://");
    } else {
      setMode("scanner");
      setUrl("https://");
    }
  }

  async function save() {
    setBusy(true);
    setMessage("");
    const fields = { mode, ...(mode === "scanner" ? { setId } : mode === "experience" ? { actionId } : { url }) };
    const creating = !current;
    try {
      const response = await fetch(creating ? "/api/ar/qrs" : `/api/ar/qrs/${current.id}`, {
        method: creating ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand, ...fields, ...(creating ? { name, slug } : { name: current.name }) })
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "That did not save");
      setMessage(creating ? "Created." : "Saved. The printed code now opens the new destination.");
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "That did not save");
    } finally {
      setBusy(false);
    }
  }

  const svg = useMemo(() => (current ? code(current.address).createSvgTag({ cellSize: 1, margin: 2, scalable: true }) : ""), [current]);

  function download(kind: "svg" | "png") {
    if (!current) return;
    const q = code(current.address);
    let href: string;
    if (kind === "svg") {
      href = URL.createObjectURL(new Blob([q.createSvgTag({ cellSize: 10, margin: 4 })], { type: "image/svg+xml" }));
    } else {
      const n = q.getModuleCount(), cell = 12, margin = 4, size = (n + margin * 2) * cell;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#000";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      href = canvas.toDataURL("image/png");
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = `${brand}-${current.slug}-qr.${kind}`;
    a.click();
  }

  return <div className="ar-qr-layout">
    <div className="ar-qr-main">
      <section className="card ar-table">
        <table>
          <thead><tr><th>Name</th><th>Address</th><th>Opens</th><th>Goes to</th></tr></thead>
          <tbody>
            {qrs.map((q) => <tr key={q.id} className={q.id === selected ? "on" : ""} onClick={() => pick(q.id)}>
              <td>{q.isMain ? "★ " : ""}{q.name}</td><td className="ar-muted">{q.address.replace(/^https:\/\//, "")}</td><td>{MODE_NAME[q.mode] || q.mode}</td><td>{q.destination}</td>
            </tr>)}
            <tr className={selected === "new" ? "on" : ""} onClick={() => pick("new")}><td colSpan={4}>+ New QR code</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card ar-edit">
        <h3>{current ? `What should “${current.name}” open?` : "New QR code"}</h3>
        {!current && <div className="ar-fields">
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Album sleeves" /></label>
          <label>Address ending<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="album-sleeves" /></label>
          <p className="ar-muted ar-small">The ending can’t be changed later and is never reused, because it’s printed in the code.</p>
        </div>}
        <div className="ar-modes">
          {MODES.map((m) => <button type="button" key={m.id} className={`ar-mode${mode === m.id ? " on" : ""}`} onClick={() => setMode(m.id)}><b>{m.title}</b><span className="ar-muted">{m.hint}</span></button>)}
        </div>
        {mode === "scanner" && <label className="ar-field">Scan set<select value={setId} onChange={(e) => setSetId(e.target.value)}>{sets.length ? sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>) : <option value="">No sets yet</option>}</select></label>}
        {mode === "experience" && <label className="ar-field">Experience<select value={actionId} onChange={(e) => setActionId(e.target.value)}>{actions.length ? actions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>) : <option value="">No actions yet</option>}</select></label>}
        {mode === "url" && <label className="ar-field">Destination (https only)<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>}
        <div className="ar-toggle">
          <button type="button" className="ar-btn primary" disabled={busy || (!current && (!name || !slug))} onClick={save}>{busy ? "Saving…" : current ? "Save destination" : "Create QR code"}</button>
          {message && <span className={message.startsWith("Saved") || message === "Created." ? "ar-muted" : "ar-error"}>{message}</span>}
        </div>
        <p className="ar-muted ar-small">ⓘ The printed QR stays the same when you change this.</p>
      </section>
    </div>

    <aside className="card ar-qr-side">
      {current ? <>
        <b>{current.name}</b>
        <div className="ar-qr-img" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="ar-muted ar-small">{current.address.replace(/^https:\/\//, "")}</div>
        <div className="ar-toggle"><button type="button" className="ar-btn" onClick={() => download("png")}>Download PNG</button><button type="button" className="ar-btn" onClick={() => download("svg")}>Download SVG</button></div>
      </> : <span className="ar-muted">Pick a code to see it.</span>}
    </aside>
  </div>;
}
