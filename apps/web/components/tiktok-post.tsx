"use client";

import { useEffect, useState } from "react";
import { Picker } from "@/components/meta-test-posts";
import { TiktokCard } from "@/app/review/tiktok-card";
import type { TiktokCreator } from "@/lib/planner-review";

type Asset = Parameters<Parameters<typeof Picker>[0]["onSelect"]>[0];

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/connections/tiktok/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

// "Post to TikTok": pick a library video, write the caption, set TikTok's required options on the
// TikTok card and send it as a direct post. Status follows TikTok's processing until it is on the profile.
export function TiktokPost({ brand }: { brand: string }) {
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [caption, setCaption] = useState("");
  const [creator, setCreator] = useState<TiktokCreator | null>(null);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<{ done?: string; profile?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!open || creator || creatorError) return;
    fetch(`/api/tiktok/creator?brand=${brand}`).then(async (r) => {
      const data = await r.json().catch(() => ({})) as TiktokCreator & { ok?: boolean; error?: string };
      if (r.ok && data.ok) setCreator(data); else setCreatorError(data.error || `HTTP ${r.status}`);
    }).catch(() => setCreatorError("Elettro OS could not reach TikTok"));
  }, [open, brand, creator, creatorError]);

  async function send(settings: Record<string, unknown>) {
    if (!asset) return;
    setBusy(true); setResult(null); setStep("Uploading to TikTok…");
    try {
      const sent = await call<{ publishId: string; profile: string }>({ brand, assetId: asset.id, caption, settings });
      // TikTok processes the video after upload; PUBLISH_COMPLETE means it is on the profile.
      for (let i = 0; i < 36; i += 1) {
        const s = await call<{ status?: string; failReason?: string }>({ brand, step: "status", publishId: sent.publishId });
        if (s.status === "PUBLISH_COMPLETE") { setResult({ done: "Posted to TikTok.", profile: sent.profile }); return; }
        if (s.status === "FAILED") throw Error(`TikTok could not publish it${s.failReason ? `: ${s.failReason}` : ""}`);
        setStep(`TikTok is processing the video… (${(i + 1) * 5}s)`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      setResult({ done: "Sent. TikTok is still processing it; it will appear on the profile shortly.", profile: sent.profile });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Post failed" });
    } finally {
      setBusy(false); setStep(null);
    }
  }

  if (!open) return <button type="button" className="status-chip" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>Post to TikTok…</button>;
  return <div className="test-post">
    <div className="eyebrow">Post to TikTok</div>
    <Picker brand={brand} network="tiktok" selected={asset} onSelect={setAsset} blockedId={null} />
    {asset && <>
      <p className="muted" style={{ margin: 0 }}>Selected: <b>{asset.title || asset.filename}</b></p>
      <label className="muted" htmlFor={`tiktok-${brand}-caption`}>Caption</label>
      <textarea id={`tiktok-${brand}-caption`} rows={3} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
      <TiktokCard post={{ tiktok: null, status: "planned", asset: { durationMs: asset.durationMs } }} creator={creator} creatorError={creatorError}
        busy={busy} actionLabel={busy ? step || "Working…" : "Post to TikTok"} onApprove={(settings) => send(settings)} />
    </>}
    {result?.done && <p className="card">{result.done}{result.profile && <> <a href={result.profile} target="_blank" rel="noreferrer">Open the profile</a></>}</p>}
    {result?.error && <p className="card">TikTok post not sent: {result.error}</p>}
  </div>;
}
