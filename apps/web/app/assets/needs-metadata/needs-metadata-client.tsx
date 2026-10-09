"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { bulkUpdateAssets, getAssetThumbnailUrl, type ApiAsset, type BulkAssetMetadata } from "@/lib/dev-api";


const MAX_METADATA_THUMBNAIL_LOADS = 6;
let activeMetadataThumbnailLoads = 0;
const metadataThumbnailQueue: Array<() => void> = [];

function pumpMetadataThumbnailQueue() {
  while (activeMetadataThumbnailLoads < MAX_METADATA_THUMBNAIL_LOADS && metadataThumbnailQueue.length) {
    const next = metadataThumbnailQueue.shift();
    if (!next) break;
    activeMetadataThumbnailLoads += 1;
    next();
  }
}

function queueMetadataThumbnailLoad(task: (release: () => void) => void) {
  let cancelled = false;

  metadataThumbnailQueue.push(() => {
    if (cancelled) {
      activeMetadataThumbnailLoads = Math.max(0, activeMetadataThumbnailLoads - 1);
      pumpMetadataThumbnailQueue();
      return;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeMetadataThumbnailLoads = Math.max(0, activeMetadataThumbnailLoads - 1);
      pumpMetadataThumbnailQueue();
    };

    task(release);
  });

  pumpMetadataThumbnailQueue();

  return () => {
    cancelled = true;
  };
}


function MetadataThumbnail({
  asset,
  onPreview
}: {
  asset: ApiAsset;
  onPreview: (asset: ApiAsset) => void;
}) {
  const baseUrl = getAssetThumbnailUrl(asset.sourcePath, asset.kind);
  const [src, setSrc] = useState<string>();
  const attemptRef = useRef(0);
  const releaseRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!baseUrl) return;

    let disposed = false;
    let cancelQueued = () => {};

    const schedule = (delay = 0) => {
      retryTimerRef.current = setTimeout(() => {
        cancelQueued = queueMetadataThumbnailLoad((release) => {
          if (disposed) {
            release();
            return;
          }

          releaseRef.current = release;
          const separator = baseUrl.includes("?") ? "&" : "?";
          setSrc(`${baseUrl}${separator}attempt=${attemptRef.current}`);
        });
      }, delay);
    };

    schedule();

    return () => {
      disposed = true;
      cancelQueued();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [baseUrl]);

  const releaseSlot = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  const handleError = () => {
    releaseSlot();
    if (attemptRef.current >= 3 || !baseUrl) return;

    attemptRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      queueMetadataThumbnailLoad((release) => {
        releaseRef.current = release;
        const separator = baseUrl.includes("?") ? "&" : "?";
        setSrc(`${baseUrl}${separator}attempt=${attemptRef.current}`);
      });
    }, 700 * attemptRef.current);
  };

  if (!baseUrl) {
    return (
      <div style={{
        width: 128,
        height: 96,
        borderRadius: 10,
        background: "var(--panel-soft)",
        display: "grid",
        placeItems: "center",
        fontSize: 12,
        color: "var(--muted)"
      }}>
        No preview
      </div>
    );
  }

  if (!src) {
    return (
      <div style={{
        width: 128,
        height: 96,
        borderRadius: 10,
        background: "var(--panel-soft)",
        display: "grid",
        placeItems: "center",
        fontSize: 12,
        color: "var(--muted)"
      }}>
        Loading…
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPreview(asset)}
      aria-label={`Open preview for ${asset.filename}`}
      style={{
        display: "inline-grid",
        placeItems: "center",
        borderRadius: 10,
        background: "var(--panel-soft)",
        overflow: "hidden",
        cursor: "zoom-in",
        border: 0,
        padding: 0,
        lineHeight: 0
      }}
    >
      <img
        src={src}
        alt={asset.filename}
        decoding="async"
        loading="lazy"
        onLoad={releaseSlot}
        onError={handleError}
        style={{
          width: "auto",
          height: "auto",
          maxWidth: 160,
          maxHeight: 140,
          objectFit: "contain",
          display: "block"
        }}
      />
    </button>
  );
}

export function NeedsMetadataClient({ assets }: { assets: ApiAsset[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState("");
  const [contentGroup, setContentGroup] = useState("");
  const [creativeFamily, setCreativeFamily] = useState("");
  const [priority, setPriority] = useState("normal");
  const [eligibilityType, setEligibilityType] = useState<"evergreen" | "annual" | "one_time">("evergreen");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previewAsset, setPreviewAsset] = useState<ApiAsset | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"all" | "image" | "video">("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [sortMode, setSortMode] = useState<"uploaded-desc" | "uploaded-asc" | "alpha-asc" | "alpha-desc" | "last-used">("uploaded-desc");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");

  useEffect(() => {
    if (!previewAsset) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewAsset(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewAsset]);

  const openPreview = (asset: ApiAsset) => {
    setPreviewAsset(asset);
  };


  const ratioForAsset = (asset: ApiAsset) =>
    asset.folderSuggestions?.aspectRatioLabel ||
    asset.aspectRatioLabel ||
    "Unknown";

  const ratioOptions = useMemo(() => {
    const values = Array.from(
      new Set(
        assets
          .map((asset) => ratioForAsset(asset))
          .filter((value) => value && value !== "Unknown")
      )
    );
    return values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [assets]);

  const visibleAssets = useMemo(() => {
    const filtered = assets.filter((asset) => {
      if (mediaFilter !== "all" && asset.kind !== mediaFilter) return false;
      if (sizeFilter !== "all" && ratioForAsset(asset) !== sizeFilter) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortMode === "alpha-asc") return a.filename.localeCompare(b.filename);
      if (sortMode === "alpha-desc") return b.filename.localeCompare(a.filename);

      if (sortMode === "last-used") {
        const aLast = (a as ApiAsset & { lastUsedAt?: string | null }).lastUsedAt;
        const bLast = (b as ApiAsset & { lastUsedAt?: string | null }).lastUsedAt;
        if (aLast && bLast) return new Date(bLast).getTime() - new Date(aLast).getTime();
        if (aLast) return -1;
        if (bLast) return 1;
      }

      const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortMode === "uploaded-asc" ? aCreated - bCreated : bCreated - aCreated;
    });
  }, [assets, mediaFilter, sizeFilter, sortMode]);

  const visibleIds = useMemo(() => new Set(visibleAssets.map((asset) => asset.id)), [visibleAssets]);
  const allSelected =
    visibleAssets.length > 0 && visibleAssets.every((asset) => selected.has(asset.id));

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selected.has(asset.id)),
    [assets, selected]
  );

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
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


      <section className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <label className="intake-control" style={{ minWidth: 150 }}>
              <span className="metric">Media</span>
              <select value={mediaFilter} onChange={(e) => setMediaFilter(e.target.value as "all" | "image" | "video")}>
                <option value="all">Videos & Images</option>
                <option value="video">Videos only</option>
                <option value="image">Images only</option>
              </select>
            </label>

            <label className="intake-control" style={{ minWidth: 130 }}>
              <span className="metric">Size</span>
              <select value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}>
                <option value="all">All sizes</option>
                {ratioOptions.map((ratio) => (
                  <option key={ratio} value={ratio}>{ratio}</option>
                ))}
              </select>
            </label>

            <label className="intake-control" style={{ minWidth: 190 }}>
              <span className="metric">Sort</span>
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)}>
                <option value="uploaded-desc">Uploaded date · newest</option>
                <option value="uploaded-asc">Uploaded date · oldest</option>
                <option value="last-used">Last used date</option>
                <option value="alpha-asc">Alphabetical · A–Z</option>
                <option value="alpha-desc">Alphabetical · Z–A</option>
              </select>
            </label>

            <button
              type="button"
              onClick={toggleAll}
              style={{ border: "1px solid var(--line)", background: "white", borderRadius: 9, padding: "10px 13px", fontWeight: 800, cursor: "pointer" }}
            >
              {allSelected ? "Unselect filtered" : `Select filtered (${visibleAssets.length})`}
            </button>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setViewMode("table")}
              style={{
                border: "1px solid var(--line)",
                background: viewMode === "table" ? "var(--accent)" : "white",
                color: viewMode === "table" ? "white" : "inherit",
                borderRadius: 9,
                padding: "9px 12px",
                fontWeight: 800,
                cursor: "pointer"
              }}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode("cards")}
              style={{
                border: "1px solid var(--line)",
                background: viewMode === "cards" ? "var(--accent)" : "white",
                color: viewMode === "cards" ? "white" : "inherit",
                borderRadius: 9,
                padding: "9px 12px",
                fontWeight: 800,
                cursor: "pointer"
              }}
            >
              Cards
            </button>
          </div>
        </div>

        <div className="muted" style={{ marginBottom: 12 }}>
          Showing {visibleAssets.length} of {assets.length} assets
          {sortMode === "last-used" ? " · unused assets fall back to upload date until publishing history is recorded" : ""}
        </div>

        {viewMode === "table" ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ padding: 8, textAlign: "left" }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all filtered" />
                  </th>
                  {["Preview", "File", "Brand", "Folder", "Topic hint", "Ratio", "Approval", "State"].map((label) => (
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
                {visibleAssets.map((asset) => {
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
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)", verticalAlign: "middle" }}>
                        <MetadataThumbnail asset={asset} onPreview={openPreview} />
                      </td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)", maxWidth: 360, verticalAlign: "middle" }}>
                        <Link href={`/assets/${asset.id}`} style={{ overflowWrap: "anywhere" }}>{asset.filename}</Link>
                      </td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{asset.brandName}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{hints.folderPath || asset.sourcePath || "—"}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{hints.topicHint || "—"}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{ratioForAsset(asset)}</td>
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
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: 16
            }}
          >
            {visibleAssets.map((asset) => {
              const hints = asset.folderSuggestions || {};
              const thumb = getAssetThumbnailUrl(asset.sourcePath, asset.kind);
              return (
                <article
                  key={asset.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 14,
                    padding: 12,
                    background: "var(--panel-soft)",
                    display: "grid",
                    gap: 10,
                    alignContent: "start"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(asset.id)}
                      onChange={() => toggleOne(asset.id)}
                      aria-label={`Select ${asset.filename}`}
                    />
                    <span className="asset-small-chip">{asset.kind}</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => openPreview(asset)}
                    style={{
                      border: 0,
                      padding: 0,
                      margin: 0,
                      background: "transparent",
                      cursor: "zoom-in",
                      width: "100%",
                      height: 260,
                      display: "grid",
                      placeItems: "center"
                    }}
                  >
                    {thumb ? (
                      <img
                        src={thumb}
                        alt={asset.filename}
                        loading="lazy"
                        decoding="async"
                        style={{
                          maxWidth: "100%",
                          maxHeight: "100%",
                          width: "auto",
                          height: "auto",
                          objectFit: "contain",
                          display: "block",
                          borderRadius: 10
                        }}
                      />
                    ) : (
                      <div className="muted">No preview</div>
                    )}
                  </button>

                  <Link
                    href={`/assets/${asset.id}`}
                    style={{
                      fontWeight: 800,
                      overflowWrap: "anywhere",
                      lineHeight: 1.35
                    }}
                  >
                    {asset.filename}
                  </Link>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <span className="status-chip">{asset.brandName}</span>
                    <span className="asset-small-chip">{ratioForAsset(asset)}</span>
                    {hints.topicHint && <span className="asset-small-chip">{hints.topicHint}</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {visibleAssets.length === 0 && (
          <div style={{ padding: "24px 0" }}>
            <strong>No assets match these filters.</strong>
          </div>
        )}
      </section>

      {selectedAssets.length > 0 && (
        <div className="muted" style={{ marginTop: 10 }}>
          Selected batch includes {selectedAssets.length} asset{selectedAssets.length === 1 ? "" : "s"}.
        </div>
      )}

      {previewAsset && getAssetThumbnailUrl(previewAsset.sourcePath, previewAsset.kind) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewAsset.filename}`}
          onClick={() => setPreviewAsset(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "grid",
            placeItems: "center",
            padding: 28,
            background: "rgba(0,0,0,0.72)",
            cursor: "zoom-out"
          }}
        >
          <div
            style={{
              maxWidth: "84vw",
              maxHeight: "86vh",
              display: "grid",
              gap: 10,
              justifyItems: "center"
            }}
          >
            <img
              src={getAssetThumbnailUrl(previewAsset.sourcePath, previewAsset.kind) || undefined}
              alt={previewAsset.filename}
              style={{
                maxWidth: "84vw",
                maxHeight: "78vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                borderRadius: 12,
                boxShadow: "0 20px 70px rgba(0,0,0,0.45)",
                background: "#111"
              }}
            />
            <div style={{ color: "white", fontSize: 13, textAlign: "center", maxWidth: "70vw", overflowWrap: "anywhere" }}>
              {previewAsset.filename}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
