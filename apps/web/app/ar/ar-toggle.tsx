"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Owner-only switch for one brand. Turning AR off changes the live public address (it serves a "not active" page),
// so it takes a second click instead of a browser dialog.
export function ArToggle({ brand, brandName, enabled }: { brand: string; brandName: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function change(next: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ar/entitlement", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand, enabled: next }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "That did not work");
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return <div className="ar-toggle">
      <button type="button" className="ar-btn primary" disabled={busy} onClick={() => change(true)}>{busy ? "Turning on…" : `Enable AR for ${brandName}`}</button>
      {error && <span className="ar-error">{error}</span>}
    </div>;
  }
  return <div className="ar-toggle">
    {confirming ? <>
      <span className="ar-muted">The public address for {brandName} will show “not active”.</span>
      <button type="button" className="ar-btn danger" disabled={busy} onClick={() => change(false)}>{busy ? "Turning off…" : "Yes, turn AR off"}</button>
      <button type="button" className="ar-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
    </> : <button type="button" className="ar-btn" onClick={() => setConfirming(true)}>Turn AR off for {brandName}</button>}
    {error && <span className="ar-error">{error}</span>}
  </div>;
}
