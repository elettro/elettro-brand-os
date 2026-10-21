"use client";

import { useState } from "react";

// Disconnect: withdraws Elettro OS's access at TikTok and unlinks the brand, after a second click
// (no browser confirm dialog). Connect TikTok afterwards shows TikTok's consent screen again.
export function TiktokDisconnect({ brand, handle }: { brand: string; handle: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/connections/tiktok/disconnect", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand })
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
      window.location.assign(`/connections?brand=${brand}&disconnected=${encodeURIComponent(handle)}&network=tiktok`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
      setBusy(false);
    }
  }

  if (!asking) return <button type="button" className="status-chip" onClick={() => setAsking(true)}>Disconnect</button>;
  return <span className="connect-row">
    <span className="muted">Remove Elettro OS&apos;s access to {handle}?</span>
    <button type="button" className="status-chip" disabled={busy} onClick={disconnect}>{busy ? "Disconnecting…" : "Yes, disconnect"}</button>
    <button type="button" className="status-chip" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
    {error && <span className="review-warn">{error}</span>}
  </span>;
}
