"use client";

import { useMemo, useState } from "react";
import { getAssetThumbnailUrl, type ApiAsset } from "@/lib/dev-api";

type SortMode = "newest" | "oldest" | "alpha" | "last-used";

function ratioForAsset(asset: ApiAsset) {
  return asset.aspectRatioLabel || asset.folderSuggestions?.aspectRatioLabel || "Unknown";
}

export function ContentPoolClient({ assets }: { assets: ApiAsset[] }) {
  const [media, setMedia] = useState<"all" | "image" | "video">("all");
  const [ratio, setRatio] = useState("all");
  const [sort, setSort] = useState<SortMode>("newest");
  const [view, setView] = useState<"cards" | "list">("cards");
  const [preview, setPreview] = useState<ApiAsset | null>(null);

  const ratios = useMemo(
    () =>
      Array.from(new Set(assets.map(ratioForAsset).filter((value) => value !== "Unknown")))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [assets]
  );

  const visible = useMemo(() => {
    const filtered = assets.filter((asset) => {
      if (media !== "all" && asset.kind !== media) return false;
      if (ratio !== "all" && ratioForAsset(asset) !== ratio) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sort === "alpha") return a.filename.localeCompare(b.filename);
      if (sort === "last-used") {
        const aUsed = (a as ApiAsset & { lastUsedAt?: string | null }).lastUsedAt;
        const bUsed = (b as ApiAsset & { lastUsedAt?: string | null }).lastUsedAt;
        if (aUsed && bUsed) return new Date(bUsed).getTime() - new Date(aUsed).getTime();
        if (aUsed) return -1;
        if (bUsed) return 1;
      }

      const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sort === "oldest" ? aCreated - bCreated : bCreated - aCreated;
    });
  }, [assets, media, ratio, sort]);

  return (
    <>
      <section className="card" style={{ marginTop: 20 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "end", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <label className="intake-control">
              <span className="metric">Media</span>
              <select value={media} onChange={(e) => setMedia(e.target.value as typeof media)}>
                <option value="all">Videos & Images</option>
                <option value="video">Videos</option>
                <option value="image">Images</option>
              </select>
            </label>

            <label className="intake-control">
              <span className="metric">Size</span>
              <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
                <option value="all">All sizes</option>
                {ratios.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>

            <label className="intake-control">
              <span className="metric">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
                <option value="newest">Uploaded · newest</option>
                <option value="oldest">Uploaded · oldest</option>
                <option value="alpha">Alphabetical</option>
                <option value="last-used">Last used</option>
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setView("cards")} className="status-chip">Cards</button>
            <button type="button" onClick={() => setView("list")} className="status-chip">List</button>
          </div>
        </div>

        <p className="muted" style={{ marginBottom: 0 }}>
          {visible.length} eligible assets. Last Used becomes authoritative when Publication Ledger is connected.
        </p>
      </section>

      {view === "cards" ? (
        <section style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 16 }}>
          {visible.map((asset) => {
            const thumb = getAssetThumbnailUrl(asset.sourcePath, asset.kind);
            return (
              <article className="card" key={asset.id} style={{ display: "grid", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setPreview(asset)}
                  style={{ border: 0, background: "transparent", padding: 0, height: 280, display: "grid", placeItems: "center", cursor: "zoom-in" }}
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={asset.filename}
                      style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain", borderRadius: 10 }}
                    />
                  ) : <span className="muted">No preview</span>}
                </button>
                <strong style={{ overflowWrap: "anywhere" }}>{asset.filename}</strong>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="status-chip">{asset.brandName}</span>
                  <span className="asset-small-chip">{asset.kind}</span>
                  <span className="asset-small-chip">{ratioForAsset(asset)}</span>
                  <span className="asset-small-chip">{asset.priority || "normal"}</span>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="card" style={{ marginTop: 16, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["File", "Brand", "Type", "Ratio", "Group", "Priority", "Eligibility"].map((label) => (
                  <th key={label} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--line)" }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((asset) => (
                <tr key={asset.id}>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.filename}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.brandName}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.kind}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{ratioForAsset(asset)}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.contentGroup || "—"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.priority || "normal"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{asset.eligibilityType || "evergreen"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview && getAssetThumbnailUrl(preview.sourcePath, preview.kind) && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "grid", placeItems: "center", background: "rgba(0,0,0,.75)", padding: 28, cursor: "zoom-out" }}
        >
          <img
            src={getAssetThumbnailUrl(preview.sourcePath, preview.kind) || undefined}
            alt={preview.filename}
            style={{ maxWidth: "88vw", maxHeight: "84vh", width: "auto", height: "auto", objectFit: "contain", borderRadius: 12 }}
          />
        </div>
      )}
    </>
  );
}
