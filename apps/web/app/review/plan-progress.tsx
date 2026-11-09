"use client";

import type { PlanNetworkStatus, PlanWeekStatus } from "@/lib/planner-review";

// Live status of a week being planned (one row per network). Shown under the week header while the planner
// runs, and as a one-line summary once every network has finished (Dean, 2026-11-07).
const STEP: Record<string, string> = { loading: "starting", picking: "picking posts", writing: "writing captions", saving: "saving" };

function line(n: PlanNetworkStatus) {
  if (n.state === "queued") return "waiting";
  if (n.state === "running") return n.step === "writing" && n.total ? `writing captions ${n.done || 0}/${n.total}` : STEP[n.step || "loading"] || "working";
  if (n.state === "done") return n.skipped ? "nothing to plan (0 per day)" : `${n.posts ?? 0} posts${n.ai ? ` · ${n.ai} AI captions` : ""}`;
  if (n.state === "stalled") return "stopped (timed out)";
  return n.error || "failed";
}

export function totals(status: PlanWeekStatus) {
  const nets = Object.values(status.networks);
  return {
    posts: nets.reduce((t, n) => t + (n.posts || 0), 0),
    ai: nets.reduce((t, n) => t + (n.ai || 0), 0),
    failed: nets.filter((n) => n.state === "failed" || n.state === "stalled").length
  };
}

export function PlanProgress({ status, names, onDismiss }: { status: PlanWeekStatus; names: Record<string, string>; onDismiss?: () => void }) {
  const entries = Object.entries(status.networks).sort(([a], [b]) => a.localeCompare(b));
  const pct = status.total ? Math.round((status.finished / status.total) * 100) : 0;
  const t = totals(status);
  return <div className={`plan-progress${status.running ? " running" : ""}`} role="status" aria-live="polite">
    <div className="plan-progress-head">
      <strong>{status.running ? `Planning… ${status.finished} of ${status.total} networks` : `Ready to review: ${t.posts} posts, ${t.ai} AI captions`}</strong>
      {!status.running && t.failed > 0 && <span className="plan-progress-warn">{t.failed} network{t.failed === 1 ? "" : "s"} failed, replan to retry</span>}
      {status.source === "tick" && <span className="muted">started by the automatic planner</span>}
      {/* A finished run's summary can be closed; a running one cannot. */}
      {!status.running && onDismiss && <button type="button" className="status-chip" style={{ marginLeft: "auto" }} aria-label="Close this summary" title="Close this summary" onClick={onDismiss}>×</button>}
    </div>
    <div className="plan-progress-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
    <ul className="plan-progress-nets">
      {entries.map(([d, n]) => <li key={d} className={`plan-net ${n.state}`}>
        <span className="plan-net-icon" aria-hidden="true">{n.state === "done" ? "✓" : n.state === "failed" || n.state === "stalled" ? "!" : n.state === "running" ? "●" : "○"}</span>
        <span className="plan-net-name">{names[d] || d}</span>
        <span className="plan-net-line">{line(n)}</span>
      </li>)}
    </ul>
  </div>;
}
