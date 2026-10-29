"use client";

import { useState } from "react";

// Disconnect for any network: a second click confirms (no browser confirm dialog). The brand's account is unlinked,
// posts already approved for it go back to planned, and Connect shows the network's consent screen again.
export function ConnectionDisconnect({ brand, network, handle }: { brand: string; network: string; handle: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function disconnect() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/connections/disconnect", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand, network })
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
      // Say so next to the button, then reload so the card flips to Connect.
      setDone(true);
      setTimeout(() => window.location.assign(`/connections?brand=${brand}&disconnected=${encodeURIComponent(handle)}&network=${network}#${network}`), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
      setBusy(false);
    }
  }

  if (done) return <span className="connect-row" role="status"><span className="status-chip">✓ Disconnect successful</span></span>;
  if (!asking) return <button type="button" className="status-chip" onClick={() => setAsking(true)}>Disconnect</button>;
  return <span className="connect-row">
    <span className="muted">Remove {handle} from this brand? Posts already approved for it go back to planned.</span>
    <button type="button" className="status-chip" disabled={busy} onClick={disconnect}>{busy ? "Disconnecting…" : "Yes, disconnect"}</button>
    <button type="button" className="status-chip" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
    {error && <span className="review-warn">{error}</span>}
  </span>;
}
