"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Cover = { id: string; name: string };
type SetRow = { id: string; name: string; slug: string; triggerIds: string[]; readiness: { ready: boolean; items: Array<{ ok: boolean; text: string }>; qrCount: number }; addresses: string[] };

async function send(url: string, method: string, body: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; problems?: string[]; triggers?: number };
  return { ok: response.ok && data.ok === true, data };
}

export function SetsManager({ brand, covers, sets }: { brand: string; covers: Cover[]; sets: SetRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(sets[0]?.id || "new");
  const current = sets.find((s) => s.id === selected) || null;
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(current?.triggerIds || []);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [problems, setProblems] = useState<string[]>([]);

  function pick(id: string) {
    const s = sets.find((x) => x.id === id) || null;
    setSelected(id);
    setMembers(s?.triggerIds || []);
    setMessage("");
    setProblems([]);
    setConfirming(false);
  }
  const name_of = (id: string) => covers.find((c) => c.id === id)?.name || "Missing cover";
  const available = covers.filter((c) => !members.includes(c.id));
  const changed = !!current && JSON.stringify([...members].sort()) !== JSON.stringify([...current.triggerIds].sort());

  async function save() {
    setBusy(true);
    setMessage("");
    setProblems([]);
    const creating = !current;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const r = creating
      ? await send("/api/ar/sets", "POST", { brand, name, slug, triggerIds: members })
      : await send(`/api/ar/sets/${current.id}`, "PATCH", { brand, triggerIds: members });
    setBusy(false);
    if (!r.ok) { setMessage(r.data.error || "That did not save"); return; }
    setMessage(creating ? "Created." : "Saved.");
    router.refresh();
  }

  async function publish() {
    if (!current) return;
    setBusy(true);
    setMessage("");
    setProblems([]);
    const r = await send(`/api/ar/sets/${current.id}/publish`, "POST", { brand });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) { setMessage(r.data.error || "Could not publish"); setProblems(r.data.problems || []); return; }
    setMessage(`Published ${r.data.triggers ?? ""} cover${r.data.triggers === 1 ? "" : "s"}. The scanner now loads the new version.`.replace("  ", " "));
    router.refresh();
  }

  return <div className="ar-sets-layout">
    <section className="card ar-table">
      <table>
        <thead><tr><th>Set</th><th>Covers</th><th>Ready</th></tr></thead>
        <tbody>
          {sets.map((s) => <tr key={s.id} className={s.id === selected ? "on" : ""} onClick={() => pick(s.id)}>
            <td>{s.name}</td><td>{s.triggerIds.length}</td><td>{s.readiness.ready ? "Yes" : "Not yet"}</td>
          </tr>)}
          <tr className={selected === "new" ? "on" : ""} onClick={() => pick("new")}><td colSpan={3}>+ New scan set</td></tr>
        </tbody>
      </table>
    </section>

    <section className="card ar-edit">
      <h3>{current ? current.name : "New scan set"}</h3>
      {!current && <label className="ar-field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Album covers" /></label>}
      {current && <p className="ar-muted ar-small">
        {current.addresses.length ? <>Opened by: {current.addresses.map((a) => a.replace(/^https:\/\//, "")).join(", ")}</> : <>No QR code opens this set yet. Make one in QR codes.</>}
      </p>}

      <div className="ar-lbl">Covers in this set ({members.length})</div>
      {members.length === 0 && <p className="ar-muted">None yet.</p>}
      <ul className="ar-members">
        {members.map((id) => <li key={id}><span>{name_of(id)}</span><button type="button" className="ar-btn" onClick={() => setMembers(members.filter((m) => m !== id))}>Remove</button></li>)}
      </ul>
      {available.length > 0 && <label className="ar-field">Add a cover
        <select value="" onChange={(e) => e.target.value && setMembers([...members, e.target.value])}>
          <option value="">Choose…</option>
          {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>}
      {covers.length === 0 && <p className="ar-muted">No covers registered yet. Add them through chat.</p>}

      {current && <>
        <div className="ar-lbl">Before you publish</div>
        <ul className="ar-checks">
          {current.readiness.items.map((i, n) => <li key={n} className={i.ok ? "ok" : "bad"}>{i.ok ? "✓" : "⚠"} {i.text}</li>)}
          {current.readiness.items.length === 0 && <li className="bad">⚠ Add at least one cover</li>}
        </ul>
      </>}

      <div className="ar-toggle">
        {(!current || changed) && <button type="button" className="ar-btn primary" disabled={busy || (!current && !name.trim())} onClick={save}>{busy ? "Saving…" : current ? "Save changes" : "Create set"}</button>}
        {current && !changed && !confirming && <button type="button" className="ar-btn primary" disabled={busy || !current.readiness.ready} onClick={() => setConfirming(true)}>Publish set</button>}
        {current && !changed && confirming && <>
          <span className="ar-muted">Publishing makes this set’s images and videos public.</span>
          <button type="button" className="ar-btn primary" disabled={busy} onClick={publish}>{busy ? "Publishing…" : "Yes, publish"}</button>
          <button type="button" className="ar-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        </>}
        {message && <span className={/^(Saved|Created|Published)/.test(message) ? "ar-muted" : "ar-error"}>{message}</span>}
      </div>
      {changed && <p className="ar-muted ar-small">Save your changes before publishing.</p>}
      {problems.length > 0 && <ul className="ar-checks">{problems.map((p, n) => <li key={n} className="bad">⚠ {p}</li>)}</ul>}
    </section>
  </div>;
}
