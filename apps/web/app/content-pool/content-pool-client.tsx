"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getAssetThumbnailUrl, type ApiAsset } from "@/lib/dev-api";

type SortMode = "newest" | "oldest" | "alpha" | "last-used";

// The AWS account allows only 10 concurrent Lambdas, so a grid asking for 100 thumbnails at once gets most of them
// throttled (503). Thumbnails load a few at a time, only when scrolled near, and a failed one retries with a pause.
const MAX_THUMBS_AT_ONCE = 4;
let thumbsLoading = 0;
const thumbQueue: Array<() => void> = [];
function acquireThumbSlot(start: () => void) {
  if (thumbsLoading < MAX_THUMBS_AT_ONCE) { thumbsLoading++; start(); } else thumbQueue.push(start);
}
function releaseThumbSlot() {
  const next = thumbQueue.shift();
  if (next) next(); else thumbsLoading = Math.max(0, thumbsLoading - 1);
}

function Thumb({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const tries = useRef(0);
  const holding = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    const begin = () => acquireThumbSlot(() => { holding.current = true; if (!cancelled) setCurrent(src); else done(); });
    const done = () => { if (holding.current) { holding.current = false; releaseThumbSlot(); } };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); begin(); }
    }, { rootMargin: "400px" });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); done(); };
  }, [src]);

  return (
    <span ref={box} style={{ display: "grid", placeItems: "center", width: "100%", height: "100%" }}>
      {failed ? <span className="muted">Preview unavailable</span> : current ? (
        <img
          src={current}
          alt={alt}
          decoding="async"
          style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain", borderRadius: 10 }}
          onLoad={() => { if (holding.current) { holding.current = false; releaseThumbSlot(); } }}
          onError={() => {
            if (holding.current) { holding.current = false; releaseThumbSlot(); }
            if (tries.current >= 3) { setFailed(true); return; }
            tries.current += 1;
            const n = tries.current;
            setTimeout(() => acquireThumbSlot(() => { holding.current = true; setCurrent(`${src}${src.includes("?") ? "&" : "?"}r=${n}`); }), 1500 * n);
          }}
        />
      ) : <span className="muted">Loading…</span>}
    </span>
  );
}

function formatLastUsed(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function ratioForAsset(asset: ApiAsset) {
  return asset.aspectRatioLabel || asset.folderSuggestions?.aspectRatioLabel || "Unknown";
}

export function ContentPoolClient({ assets }: { assets: ApiAsset[] }) {
  const [media, setMedia] = useState<"all" | "image" | "video" | "audio" | "carousel" | "document">("all");
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
        const aUsed = a.lastUsedAt;
        const bUsed = b.lastUsedAt;
        if (aUsed && bUsed) return new Date(bUsed).getTime() - new Date(aUsed).getTime();
        if (aUsed) return -1;
        if (bUsed) return 1;
        return a.filename.localeCompare(b.filename);
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
                <option value="all">All media</option>
                <option value="video">Videos</option>
                <option value="image">Images</option>
                <option value="carousel">Carousels</option>
                <option value="audio">Audio (songs)</option>
                <option value="document">PDF documents</option>
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
          {visible.length} eligible assets. Last Used is derived from Publication Ledger.
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
                  {thumb ? <Thumb src={thumb} alt={asset.filename} /> : <span className="muted">{asset.kind === "audio" ? "♪ Audio" : "No preview"}</span>}
                </button>
                <strong style={{ overflowWrap: "anywhere" }}>{asset.filename}</strong>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="status-chip">{asset.brandName}</span>
                  <span className="asset-small-chip">{asset.kind}</span>
                  <span className="asset-small-chip">{ratioForAsset(asset)}</span>
                  <span className="asset-small-chip">{asset.priority || "normal"}</span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Last used: <strong>{formatLastUsed(asset.lastUsedAt)}</strong>
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
                {["File", "Brand", "Type", "Ratio", "Group", "Priority", "Eligibility", "Last Used"].map((label) => (
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
                  <td style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>{formatLastUsed(asset.lastUsedAt)}</td>
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
