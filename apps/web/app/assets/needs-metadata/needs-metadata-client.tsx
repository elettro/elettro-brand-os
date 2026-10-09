"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { bulkUpdateAssets, type ApiAsset, type BulkAssetMetadata } from "@/lib/dev-api";

export function NeedsMetadataClient({ assets }: { assets: ApiAsset[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("");
  const [contentGroup, setContentGroup] = useState("");
  const [creativeFamily, setCreativeFamily] = useState("");
  const [priority, setPriority] = useState("normal");
  const [eligibilityType, setEligibilityType] = useState<"evergreen" | "annual" | "one_time">("evergreen");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const allSelected = assets.length > 0 && selected.size === assets.length;
  const selectedAssets = useMemo(
    () => assets.filter((asset) => selected.has(asset.id)),
    [assets, selected]
  );

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(assets.map((asset) => asset.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = async (markReady: boolean) => {
    if (!selected.size) {
      setMessage("Select at least one asset.");
      return;
    }

    setBusy(true);
    setMessage("");

    try {
      const metadata: BulkAssetMetadata = {
        priority,
        eligibilityType
      };
      if (topic.trim()) metadata.topic = topic.trim();
      if (contentGroup.trim()) metadata.contentGroup = contentGroup.trim();
      if (creativeFamily.trim()) metadata.creativeFamily = creativeFamily.trim();

      const result = await bulkUpdateAssets({
        assetIds: Array.from(selected),
        metadata,
        markReady
      });

      setMessage(
        markReady
          ? `${result.updated} assets updated and marked ready.`
          : `${result.updated} assets updated.`
      );

      if (markReady) {
        setTimeout(() => window.location.reload(), 700);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card" style={{ marginTop: 20 }}>
        <div className="eyebrow">Bulk metadata</div>
        <h2 style={{ marginBottom: 6 }}>Apply shared meaning once</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Select a batch, set shared metadata, then mark the batch ready. Leave fields blank to preserve per-asset values.
        </p>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", marginTop: 14 }}>
          <label className="intake-control">
            <span className="metric">Topic / subject</span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Stashbox Does Sublime" />
          </label>

          <label className="intake-control">
            <span className="metric">Content group</span>
            <input value={contentGroup} onChange={(e) => setContentGroup(e.target.value)} placeholder="e.g. live performance" />
          </label>

          <label className="intake-control">
            <span className="metric">Creative family</span>
            <input value={creativeFamily} onChange={(e) => setCreativeFamily(e.target.value)} placeholder="e.g. Sublime promo" />
          </label>

          <label className="intake-control">
            <span className="metric">Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="intake-control">
            <span className="metric">Eligibility</span>
            <select
              value={eligibilityType}
              onChange={(e) => setEligibilityType(e.target.value as "evergreen" | "annual" | "one_time")}
            >
              <option value="evergreen">Evergreen</option>
              <option value="annual">Annual window</option>
              <option value="one_time">One-time window</option>
            </select>
          </label>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
          <button
            type="button"
            disabled={busy || !selected.size}
            onClick={() => apply(false)}
            style={{ border: "1px solid var(--line)", background: "white", borderRadius: 9, padding: "10px 13px", fontWeight: 800, cursor: "pointer" }}
          >
            Save metadata
          </button>

          <button
            type="button"
            disabled={busy || !selected.size}
            onClick={() => apply(true)}
            style={{ border: 0, background: "var(--accent)", color: "white", borderRadius: 9, padding: "10px 13px", fontWeight: 800, cursor: "pointer" }}
          >
            Mark {selected.size || 0} ready
          </button>

          <span className="muted">{selected.size} selected</span>
          {message && <strong style={{ fontSize: 13 }}>{message}</strong>}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ padding: 8, textAlign: "left" }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              {["File", "Brand", "Folder", "Topic hint", "Ratio", "Approval", "State"].map((label) => (
                <th
                  key={label}
                  style={{
                    textAlign: "left",
                    padding: "10px 8px",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 12,
                    color: "var(--muted)"
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const hints = asset.folderSuggestions || {};
              return (
                <tr key={asset.id}>
                  <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(asset.id)}
                      onChange={() => toggleOne(asset.id)}
                      aria-label={`Select ${asset.filename}`}
                    />
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)", maxWidth: 360 }}>
                    <Link href={`/assets/${asset.id}`} style={{ overflowWrap: "anywhere" }}>{asset.filename}</Link>
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{asset.brandName}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    {hints.folderPath || asset.sourcePath || "—"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{hints.topicHint || "—"}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    {hints.aspectRatioLabel || asset.aspectRatioLabel || "—"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    <span className="status-chip">{asset.approvalStatus || "—"}</span>
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    <span className="asset-small-chip">{asset.enrichmentStatus || asset.ingestStatus || "—"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {assets.length === 0 && (
          <div style={{ padding: "24px 0" }}>
            <strong>No assets are currently waiting for metadata.</strong>
          </div>
        )}
      </section>

      {selectedAssets.length > 0 && (
        <div className="muted" style={{ marginTop: 10 }}>
          Selected batch includes {selectedAssets.length} asset{selectedAssets.length === 1 ? "" : "s"}.
        </div>
      )}
    </>
  );
}
