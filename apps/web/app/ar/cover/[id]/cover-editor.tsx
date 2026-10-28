"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Action = { id: string; name: string; type: string };
type Placement = { x: number; y: number; s: number };

async function send(url: string, method: string, body: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: response.ok && data.ok === true, error: data.error };
}

const SLIDERS: Array<{ key: keyof Placement; label: string; min: number; max: number; step: number }> = [
  { key: "x", label: "Left / right", min: -0.25, max: 0.25, step: 0.001 },
  { key: "y", label: "Up / down", min: -0.25, max: 0.25, step: 0.001 },
  { key: "s", label: "Size", min: 0.8, max: 1.4, step: 0.005 }
];

export function CoverEditor({ brand, coverId, name, thumbUrl, placement, ruleId, actionIds, actions, scanLinks }: {
  brand: string; coverId: string; name: string; thumbUrl: string | null; placement: Placement; ruleId: string | null; actionIds: string[]; actions: Action[]; scanLinks: string[];
}) {
  const router = useRouter();
  const [place, setPlace] = useState<Placement>(placement);
  const [chosen, setChosen] = useState<string[]>(actionIds);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const nameOf = (id: string) => actions.find((a) => a.id === id)?.name || "Missing action";
  const unused = actions.filter((a) => !chosen.includes(a.id));
  const placeChanged = place.x !== placement.x || place.y !== placement.y || place.s !== placement.s;
  const actionsChanged = JSON.stringify(chosen) !== JSON.stringify(actionIds);

  async function savePlacement() {
    setBusy("placement");
    setMessage("");
    const r = await send(`/api/ar/triggers/${coverId}`, "PATCH", { brand, placement: place });
    setBusy("");
    setMessage(r.ok ? "Placement saved. Publish the set to send it to phones." : r.error || "That did not save");
    if (r.ok) router.refresh();
  }

  async function saveActions() {
    setBusy("actions");
    setMessage("");
    const r = ruleId
      ? await send(`/api/ar/rules/${ruleId}`, "PATCH", { brand, actionIds: chosen })
      : await send("/api/ar/rules", "POST", { brand, triggerId: coverId, actionIds: chosen });
    setBusy("");
    setMessage(r.ok ? "Actions saved. Publish the set to send them to phones." : r.error || "That did not save");
    if (r.ok) router.refresh();
  }

  const move = (i: number, d: number) => {
    const next = [...chosen];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setChosen(next);
  };

  return <div className="ar-cover-layout">
    <section className="card">
      <div className="ar-thumb">{thumbUrl ? <img src={thumbUrl} alt={name} /> : <span className="ar-muted">No image</span>}</div>
      <div className="ar-lbl">Test it on your phone</div>
      {scanLinks.length ? <ul className="ar-members">{scanLinks.map((l) => <li key={l}><a href={l} target="_blank" rel="noreferrer">{l.replace(/^https:\/\//, "")}</a></li>)}</ul> : <p className="ar-muted ar-small">Put this cover in a scan set that a QR code opens (Scan sets, QR codes), then point your phone camera at the printed cover.</p>}
    </section>

    <div className="ar-qr-main">
      <section className="card ar-edit">
        <h3>What happens when it’s scanned</h3>
        {chosen.length === 0 && <p className="ar-warn">⚠ Nothing yet. Add an action below.</p>}
        <ul className="ar-members">
          {chosen.map((id, i) => <li key={id}>
            <span>{i + 1}. {nameOf(id)}</span>
            <span className="ar-toggle">
              <button type="button" className="ar-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button type="button" className="ar-btn" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
              <button type="button" className="ar-btn" onClick={() => setChosen(chosen.filter((c) => c !== id))}>Remove</button>
            </span>
          </li>)}
        </ul>
        {unused.length > 0 && <label className="ar-field">Add an action
          <select value="" onChange={(e) => e.target.value && setChosen([...chosen, e.target.value])}>
            <option value="">Choose…</option>
            {unused.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
          </select>
        </label>}
        {actions.length === 0 && <p className="ar-muted ar-small">No actions exist for this brand yet. Videos and link buttons are added through chat.</p>}
        <div className="ar-toggle"><button type="button" className="ar-btn primary" disabled={!actionsChanged || chosen.length === 0 || busy !== ""} onClick={saveActions}>{busy === "actions" ? "Saving…" : "Save actions"}</button></div>
      </section>

      <section className="card ar-edit">
        <h3>Placement</h3>
        <p className="ar-muted ar-small">Nudge the overlay onto the printed art. Printed shirts and posters often need about 1.12× size; test on the real print, then adjust.</p>
        {SLIDERS.map((s) => <label className="ar-field" key={s.key}>
          <span>{s.label}: <b>{place[s.key].toFixed(s.key === "s" ? 3 : 3)}{s.key === "s" ? "×" : ""}</b></span>
          <input type="range" min={s.min} max={s.max} step={s.step} value={place[s.key]} onChange={(e) => setPlace({ ...place, [s.key]: Number(e.target.value) })} />
        </label>)}
        <div className="ar-toggle">
          <button type="button" className="ar-btn primary" disabled={!placeChanged || busy !== ""} onClick={savePlacement}>{busy === "placement" ? "Saving…" : "Save placement"}</button>
          <button type="button" className="ar-btn" disabled={!placeChanged} onClick={() => setPlace(placement)}>Undo</button>
          <button type="button" className="ar-btn" onClick={() => setPlace({ x: 0, y: 0, s: 1 })}>Reset to centered</button>
        </div>
      </section>
      {message && <p className={/saved/i.test(message) ? "ar-muted" : "ar-error"}>{message}</p>}
    </div>
  </div>;
}
