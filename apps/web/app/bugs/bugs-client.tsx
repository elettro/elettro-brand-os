"use client";

import { useMemo, useState } from "react";

export type Bug = {
  id: string; title: string; status: string; verification?: string; severity: string; area: string; environment: string;
  reported_at?: string | null; fixed_at?: string | null; verified_at?: string | null;
  symptom?: string; root_cause?: string; fix_summary?: string; future_repair?: string;
  files_changed?: string[]; commits?: string[]; related?: string[]; record?: string;
};

const OPEN = ["Open", "Investigating", "Reopened"];
const REPO = "https://github.com/elettro/elettro-brand-os/blob/develop/";
const tone = (v: string) => (["Critical", "High", "Open", "Reopened", "Investigating"].includes(v) ? "bad" : ["Fixed", "Verified", "Low"].includes(v) ? "good" : "warn");

export function BugsClient({ bugs, updated }: { bugs: Bug[]; updated: string }) {
  const [q, setQ] = useState("");
  const [f, setF] = useState({ status: "", area: "", severity: "", environment: "" });
  const uniq = (k: keyof Bug) => [...new Set(bugs.map((b) => b[k] as string).filter(Boolean))].sort();
  const shown = useMemo(() => bugs.filter((b) => {
    const hay = [b.id, b.title, b.status, b.verification, b.severity, b.area, b.environment, b.symptom, b.root_cause, b.fix_summary, b.future_repair, ...(b.files_changed || []), ...(b.commits || []), ...(b.related || [])].join(" ").toLowerCase();
    return (!q || hay.includes(q.trim().toLowerCase())) && (!f.status || b.status === f.status) && (!f.area || b.area === f.area) && (!f.severity || b.severity === f.severity) && (!f.environment || b.environment === f.environment);
  }).sort((a, b) => b.id.localeCompare(a.id)), [bugs, q, f]);
  const verified = (b: Bug) => b.status === "Verified" || b.verification === "Verified";
  const select = (key: keyof typeof f, label: string, values: string[]) => (
    <select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} aria-label={label}>
      <option value="">All {label}</option>{values.map((v) => <option key={v}>{v}</option>)}
    </select>
  );
  return <div className="bugs">
    <div className="bugs-stats">
      <div><small>Total</small><strong>{bugs.length}</strong></div>
      <div><small>Open</small><strong>{bugs.filter((b) => OPEN.includes(b.status)).length}</strong></div>
      <div><small>Fixed, unverified</small><strong>{bugs.filter((b) => b.status === "Fixed" && !verified(b)).length}</strong></div>
      <div><small>Verified</small><strong>{bugs.filter(verified).length}</strong></div>
    </div>
    <div className="bugs-controls">
      <input type="search" placeholder="Search symptom, title, file, PR…" value={q} onChange={(e) => setQ(e.target.value)} />
      {select("status", "statuses", uniq("status"))}{select("area", "areas", uniq("area"))}
      {select("severity", "severities", uniq("severity"))}{select("environment", "environments", uniq("environment"))}
    </div>
    {!shown.length && <p className="card">No bugs match these filters.</p>}
    {shown.map((b) => <article className="card bug" key={b.id}>
      <div className="bug-top">
        <div><span className="bug-id">{b.id}</span><h2>{b.title}</h2></div>
        <div className="bug-pills">
          <span className={`pill ${tone(b.severity)}`}>{b.severity}</span>
          <span className={`pill ${tone(b.status)}`}>{b.status}</span>
          <span className={`pill ${verified(b) ? "good" : "warn"}`}>{verified(b) ? "Verified" : "Not verified"}</span>
        </div>
      </div>
      <p className="muted bug-meta">{b.area} · {b.environment} · Reported {b.reported_at || "—"}{b.fixed_at ? ` · Fixed ${b.fixed_at}` : ""}{b.verified_at ? ` · Verified ${b.verified_at}` : ""}</p>
      <div className="bug-grid">
        <div><h3>Symptom</h3><p>{b.symptom || "—"}</p></div>
        <div><h3>Root cause</h3><p>{b.root_cause || "Not established yet."}</p></div>
        <div><h3>Fix</h3><p>{b.fix_summary || "No fix recorded yet."}</p></div>
        <div><h3>Future repair</h3><p>{b.future_repair || "Not documented yet."}</p></div>
      </div>
      <div className="bug-links">
        {b.record && <a href={REPO + b.record} target="_blank" rel="noreferrer">Full record</a>}
        {(b.commits || []).map((c) => <span key={c} className="pill">{c}</span>)}
        {(b.related || []).map((r) => <button key={r} type="button" onClick={() => setQ(r)}>{r}</button>)}
      </div>
    </article>)}
    <p className="muted bug-src">Source of truth: <code>docs/bug-fix/</code> · registry updated {updated} · new bugs: copy <code>BUG_TEMPLATE.md</code>, then add to <code>bugs.json</code> and <code>BUG_INDEX.md</code>.</p>
  </div>;
}
