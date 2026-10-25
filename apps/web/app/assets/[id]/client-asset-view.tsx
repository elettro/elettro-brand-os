"use client";

import { useState } from "react";
import Link from "next/link";
import { AssetThumb } from "@/components/asset-thumb";
import type { ApiAsset } from "@/lib/dev-api";

// Read-only asset page for a client account. On a shared creative asset they can tag or untag their own brands, nothing else.
export function ClientAssetView({ asset, brands }: { asset: ApiAsset; brands: { id: string; name: string }[] }) {
  const shared = asset.brandSlug === "creative-assets";
  const [tagged, setTagged] = useState<string[]>((asset.allowedBrandSlugs || []).filter((slug) => brands.some((b) => b.id === slug)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function toggle(id: string) {
    const next = tagged.includes(id) ? tagged.filter((x) => x !== id) : [...tagged, id];
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/assets/brand-tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, brands: next })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `Could not save (${response.status})`);
      setTagged(next);
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="main">
      <div className="eyebrow"><Link href="/assets">Assets</Link> · {asset.brandName}</div>
      <h1>{asset.title || asset.filename}</h1>
      <p className="muted">View only. {shared ? "This is a shared creative asset: you can choose which of your brands it is tagged for." : "Changes to your brand folders are made by Elettro."}</p>
      <div className="card" style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 16 }}>
        <AssetThumb asset={{ filename: asset.filename, kind: asset.kind, sourcePath: asset.sourcePath ?? null, title: asset.title ?? null, durationMs: asset.durationMs ?? null }} size={240} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <p><strong>{asset.filename}</strong></p>
          {asset.aiDescription && <p>{asset.aiDescription}</p>}
          <p className="muted">{[asset.kind, asset.aspectRatioLabel, asset.topic, asset.contentGroup].filter(Boolean).join(" · ")}</p>
          {!!asset.tags?.length && <p className="muted">Tags: {asset.tags.join(", ")}</p>}
        </div>
      </div>
      {shared && (
        <section className="card" style={{ marginTop: 16 }} aria-label="Brand tags">
          <h2>Use for my brands</h2>
          <p className="muted">Tick a brand to tag this asset for it, untick to remove the tag.</p>
          {brands.map((b) => (
            <label key={b.id} style={{ display: "block", margin: "8px 0" }}>
              <input type="checkbox" checked={tagged.includes(b.id)} disabled={busy} onChange={() => toggle(b.id)} /> {b.name}
            </label>
          ))}
          {message && <p role="status" className="muted">{message}</p>}
        </section>
      )}
    </main>
  );
}
