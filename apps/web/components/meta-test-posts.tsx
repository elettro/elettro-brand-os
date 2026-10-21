"use client";

import { useEffect, useState } from "react";
import { AssetThumb } from "@/components/asset-thumb";

type Asset = { id: string; filename: string; kind: string; sourcePath: string | null; title: string | null; aspectRatioLabel: string | null; durationMs: number | null; mimeType: string | null };
type Network = "instagram" | "facebook" | "tiktok" | "pinterest";

const DEFAULT_CAPTION = "Testing Elettro OS: this post went out through our own publishing system. More from Stashbox soon.";
const isJpeg = (a: Asset) => /\.jpe?g$/i.test(a.filename) || a.mimeType === "image/jpeg";

async function call<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

// Library picker: the brand's approved, ready photos and videos, 36 at a time.
export function Picker({ brand, network, selected, onSelect, blockedId }: {
  brand: string; network: Network; selected: Asset | null; onSelect: (a: Asset) => void; blockedId: string | null;
}) {
  const [kind, setKind] = useState<"video" | "image">(network === "pinterest" ? "image" : "video");
  const [q, setQ] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(offset = 0) {
    setError(null);
    try {
      const data = await call<{ assets: Asset[]; more: boolean }>("/api/planner/review", { brand, action: "assets", kind, q, offset, limit: 36 });
      setAssets(offset ? [...assets, ...data.assets] : data.assets);
      setMore(data.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library");
    }
  }
  useEffect(() => { load(0); }, [kind]);
  const why = (a: Asset) => a.id === blockedId ? "Just posted to Instagram"
    : network === "instagram" && a.kind === "image" && !isJpeg(a) ? "Instagram needs a JPEG"
    : network === "tiktok" && a.kind !== "video" ? "TikTok posts videos"
    : network === "pinterest" && a.kind !== "image" ? "Pins here are photos" : null;
  return <div className="picker">
    <div className="picker-bar">
      <button type="button" className={`status-chip ${kind === "video" ? "on" : ""}`} onClick={() => setKind("video")}>Videos</button>
      <button type="button" className={`status-chip ${kind === "image" ? "on" : ""}`} onClick={() => setKind("image")}>Photos</button>
      <form onSubmit={(e) => { e.preventDefault(); load(0); }}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filename or title" /></form>
    </div>
    {error && <p className="review-warn">{error}</p>}
    <div className="picker-grid">
      {assets.map((a) => {
        const blocked = why(a);
        return <button type="button" key={a.id} disabled={!!blocked} title={blocked || a.title || a.filename}
          className={`picker-item ${selected?.id === a.id ? "selected" : ""}`} onClick={() => onSelect(a)}>
          <AssetThumb asset={a} size={84} />
          <span>{blocked || a.title || a.filename}</span>
        </button>;
      })}
    </div>
    {more && <button type="button" className="status-chip" onClick={() => load(assets.length)}>Show more</button>}
  </div>;
}

function TestPost({ brand, network, account, blockedId, onPosted }: {
  brand: string; network: Network; account: string; blockedId: string | null; onPosted: (asset: Asset) => void;
}) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [caption, setCaption] = useState(DEFAULT_CAPTION);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<{ url?: string; error?: string; logged?: boolean } | null>(null);
  const label = network === "instagram" ? "Instagram" : "Facebook";
  const format = !asset ? "" : asset.kind === "image" ? (network === "instagram" ? "feed photo" : "photo post")
    : asset.aspectRatioLabel === "9x16" || network === "instagram" ? "Reel" : "video";

  async function post() {
    if (!asset) return;
    setBusy(true); setResult(null);
    try {
      if (network === "facebook") {
        setStep("Sending to Facebook…");
        const r = await call<{ url: string; logged: boolean }>("/api/connections/meta/test-post", { brand, network, assetId: asset.id, caption });
        setResult(r); onPosted(asset);
        return;
      }
      setStep("Uploading to Instagram…");
      const started = await call<{ containerId: string; placement: string }>("/api/connections/meta/test-post", { brand, network, step: "start", assetId: asset.id, caption });
      // Reels take a while to process; Instagram says FINISHED when the container can be published.
      for (let i = 0; i < 60; i += 1) {
        const s = await call<{ status: string; detail: string | null }>("/api/connections/meta/test-post", { brand, network, step: "status", containerId: started.containerId });
        if (s.status === "FINISHED") break;
        if (s.status === "ERROR" || s.status === "EXPIRED") throw Error(`Instagram could not process the file${s.detail ? `: ${s.detail}` : ""}`);
        setStep(`Instagram is processing the ${started.placement === "reel" ? "Reel" : "photo"}… (${(i + 1) * 5}s)`);
        await new Promise((r) => setTimeout(r, 5000));
        if (i === 59) throw Error("Instagram is still processing after 5 minutes; try again later");
      }
      setStep("Publishing…");
      const r = await call<{ url: string; logged: boolean }>("/api/connections/meta/test-post", { brand, network, step: "publish", containerId: started.containerId, assetId: asset.id, placement: started.placement });
      setResult(r); onPosted(asset);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Post failed" });
    } finally {
      setBusy(false); setStep(null);
    }
  }

  return <div className="test-post">
    <div className="eyebrow">Test post · {label} · {account}</div>
    <Picker brand={brand} network={network} selected={asset} onSelect={setAsset} blockedId={blockedId} />
    {asset && <p className="muted" style={{ margin: 0 }}>Selected: <b>{asset.title || asset.filename}</b> · posts as a {format}</p>}
    <label className="muted" htmlFor={`meta-${network}-caption`}>Caption (goes live on {label} when you click)</label>
    <textarea id={`meta-${network}-caption`} rows={3} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
    <button type="button" className="status-chip" disabled={!asset || !caption.trim() || busy} onClick={post}>
      {busy ? step || "Working…" : `Post to ${label} now`}
    </button>
    {result?.url && <p className="card">Posted to {label}. <a href={result.url} target="_blank" rel="noreferrer">See the post</a>
      {result.logged === false && <span className="muted"> (live, but not logged for the dashboard)</span>}</p>}
    {result?.error && <p className="card">{label} post not sent: {result.error}</p>}
  </div>;
}

export function MetaTestPosts({ brand, page, instagram }: { brand: string; page: string; instagram: string | null }) {
  // Facebook gets a different asset than the latest Instagram test post, this session or earlier.
  const [lastInstagram, setLastInstagram] = useState<string | null>(null);
  useEffect(() => {
    call<{ publications: Array<{ destination: string; assetId: string }> }>("/api/planner/review", { brand, action: "recent-publications" })
      .then((d) => setLastInstagram(d.publications.find((p) => p.destination === "instagram")?.assetId || null))
      .catch(() => {});
  }, [brand]);
  return <>
    {instagram && <TestPost brand={brand} network="instagram" account={instagram} blockedId={null} onPosted={(a) => setLastInstagram(a.id)} />}
    <TestPost brand={brand} network="facebook" account={page} blockedId={lastInstagram} onPosted={() => {}} />
  </>;
}
