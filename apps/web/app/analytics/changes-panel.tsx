"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Changes for next week (Dean, 2026-11-08): nothing reaches the planner until approved here; Undo is always one click.
export type PlannerChange = {
  id: string; kind: string; title: string; detail: string | null; status: "watching" | "proposed" | "approved" | "skipped" | "undone";
  weekKey: string; seenWeeks: number; skips: number; mutedUntil: string | null; weightsVersion: number | null; decidedAt: string | null;
  evidence: { account?: string; destination?: string; bucket?: string; posts?: number; lift?: number; rawLift?: number } | null;
  outcome?: { label: "helped" | "hurt" | "no clear difference" | "waiting"; posts: number; lift: number | null; bucket: string | null; checkedAt: string; undoSuggested: boolean } | null;
};

// The weekly grade of an approved change: how the boosted asset's posts since approval did against their accounts' normal.
function outcomeText(o: NonNullable<PlannerChange["outcome"]>) {
  if (o.label === "waiting") return "Waiting: no new post of this asset yet";
  const head = o.label === "helped" ? "Helped" : o.label === "hurt" ? "Hurt" : "No clear difference";
  return `${head}: ${o.lift}x normal over ${o.posts} post${o.posts === 1 ? "" : "s"} (${o.bucket})`;
}
export type ChangesList = { ok: boolean; error?: string; weightsVersion: number; activeBoosts: number; changes: PlannerChange[] };

const STATUS_LABEL: Record<PlannerChange["status"], string> = {
  proposed: "Needs your OK", approved: "Approved", watching: "Watching: needs a second week", skipped: "Skipped", undone: "Undone"
};

export function ChangesPanel({ brand, initial }: { brand: string; initial: ChangesList | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function call(action: string, extra: Record<string, string> = {}) {
    setBusy(extra.id || action);
    setNote(null);
    try {
      const r = await fetch("/api/analytics/changes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand, action, ...extra }) });
      const data = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (!data.ok) setNote(data.error || "That didn't work");
      else if (action === "changes-refresh") setNote(`Checked: ${data.candidates} candidate${data.candidates === 1 ? "" : "s"}, ${data.watching} new to watch, ${data.proposed} now need your OK.`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }
  if (!initial || !initial.ok) return <section className="card an-section" aria-labelledby="an-changes">
    <h2 id="an-changes">Changes for next week</h2>
    <p className="muted">Not set up yet{initial?.error ? ` (${initial.error})` : ""}. After the next deploy the change log table is created, and proposals appear here.</p>
  </section>;
  const open = initial.changes.filter((c) => c.status === "proposed");
  const rest = initial.changes.filter((c) => c.status !== "proposed");
  return <section className="card an-section" aria-labelledby="an-changes">
    <div className="an-head-row">
      <h2 id="an-changes">Changes for next week</h2>
      <button type="button" className="status-chip" disabled={!!busy} onClick={() => call("changes-refresh")}>{busy === "changes-refresh" ? "Checking…" : "Check now"}</button>
    </div>
    <p className="muted">Planner weights v{initial.weightsVersion} · {initial.activeBoosts} boost{initial.activeBoosts === 1 ? "" : "s"} active. A finding is watched for one week and proposed only if it holds up the next. Checked automatically every Sunday night; approved changes are graded then too. Approving adds score points only; cooldowns, date windows, approvals and format rules never change. Every approval can be undone.</p>
    {note && <p className="an-note" role="status">{note}</p>}
    {open.length === 0 && <p className="muted">Nothing needs your OK right now.</p>}
    <ul className="an-list">{[...open, ...rest].map((c) => <li key={c.id} className={c.status === "proposed" ? undefined : "an-weak"}>
      <div className="an-change">
        <strong>{c.title}</strong>
        <span className={`an-chip ${c.status === "approved" ? "ok" : c.status === "proposed" ? "late" : ""}`}>{STATUS_LABEL[c.status]}{c.weightsVersion && c.status === "approved" ? ` · v${c.weightsVersion}` : ""}</span>
        {c.detail && <p className="muted">{c.detail}</p>}
        {c.status === "approved" && c.outcome && <p className={c.outcome.label === "hurt" ? "an-gap" : c.outcome.label === "helped" ? "an-good" : "muted"}>
          {outcomeText(c.outcome)}{c.outcome.undoSuggested ? ". Hurt two weeks running: Undo suggested." : ""} <span className="muted">(checked {c.outcome.checkedAt.slice(0, 10)})</span>
        </p>}
      </div>
      <div className="an-actions">
        {(c.status === "proposed" || c.status === "skipped") && <button type="button" className="status-chip" disabled={!!busy} onClick={() => call("change-decide", { id: c.id, decision: "approve" })}>Approve</button>}
        {c.status === "proposed" && <button type="button" className="status-chip" disabled={!!busy} onClick={() => call("change-decide", { id: c.id, decision: "skip" })}>Skip</button>}
        {c.status === "approved" && <button type="button" className="status-chip" disabled={!!busy} onClick={() => call("change-decide", { id: c.id, decision: "undo" })}>Undo</button>}
      </div>
    </li>)}</ul>
  </section>;
}
