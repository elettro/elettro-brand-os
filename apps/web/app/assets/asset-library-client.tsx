"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAssetThumbnailUrl, type ApiAsset } from "@/lib/dev-api";

const MAX_THUMBNAIL_LOADS = 6;
let activeThumbnailLoads = 0;
const thumbnailQueue: Array<() => void> = [];

function pumpThumbnailQueue() {
  while (activeThumbnailLoads < MAX_THUMBNAIL_LOADS && thumbnailQueue.length) {
    const next = thumbnailQueue.shift();
    if (!next) break;
    activeThumbnailLoads += 1;
    next();
  }
}

function queueThumbnailLoad(task: (release: () => void) => void) {
  let cancelled = false;
  thumbnailQueue.push(() => {
    if (cancelled) {
      activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
      pumpThumbnailQueue();
      return;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
      pumpThumbnailQueue();
    };

    task(release);
  });
  pumpThumbnailQueue();

  return () => {
    cancelled = true;
  };
}

function AssetThumbnail({
  sourcePath,
  kind,
  filename
}: {
  sourcePath: string;
  kind: string;
  filename: string;
}) {
  const baseUrl = getAssetThumbnailUrl(sourcePath, kind);
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
        cancelQueued = queueThumbnailLoad((release) => {
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
      queueThumbnailLoad((release) => {
        releaseRef.current = release;
        const separator = baseUrl.includes("?") ? "&" : "?";
        setSrc(`${baseUrl}${separator}attempt=${attemptRef.current}`);
      });
    }, 700 * attemptRef.current);
  };

  if (!src) {
    return <div className="asset-thumbnail-loading">Loading preview…</div>;
  }

  return (
    <img
      className="asset-thumbnail"
      src={src}
      alt={filename}
      decoding="async"
      onLoad={releaseSlot}
      onError={handleError}
    />
  );
}

function formatBytes(value: ApiAsset["fileSizeBytes"]) {
  const bytes = Number(value || 0);
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / Math.pow(1024, index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function kindGlyph(kind: string) {
  return kind === "video" ? "▶" : "▧";
}

export function AssetLibraryClient({ assets }: { assets: ApiAsset[] }) {
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("all");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");

  const brands = useMemo(
    () => Array.from(new Map(assets.map((asset) => [asset.brandSlug, asset.brandName])).entries()),
    [assets]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const matchesQuery =
        !needle ||
        asset.filename.toLowerCase().includes(needle) ||
        asset.sourcePath?.toLowerCase().includes(needle) ||
        asset.contentGroup?.toLowerCase().includes(needle) ||
        asset.topic?.toLowerCase().includes(needle);
      const matchesBrand = brand === "all" || asset.brandSlug === brand;
      const matchesKind = kind === "all" || asset.kind === kind;
      const matchesStatus = status === "all" || asset.ingestStatus === status;
      return matchesQuery && matchesBrand && matchesKind && matchesStatus;
    });
  }, [assets, brand, kind, query, status]);

  const imageCount = assets.filter((asset) => asset.kind === "image").length;
  const videoCount = assets.filter((asset) => asset.kind === "video").length;
  const rawCount = assets.filter((asset) => asset.ingestStatus === "raw").length;

  return (
    <>
      <div className="grid stats" style={{ marginBottom: 16 }}>
        <div className="card"><div className="metric">Indexed assets</div><div className="metric-value">{assets.length}</div></div>
        <div className="card"><div className="metric">Images</div><div className="metric-value">{imageCount}</div></div>
        <div className="card"><div className="metric">Videos</div><div className="metric-value">{videoCount}</div></div>
        <div className="card"><div className="metric">Awaiting enrichment</div><div className="metric-value">{rawCount}</div></div>
      </div>

      <div className="card asset-toolbar">
        <input
          className="asset-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search filename, folder, topic..."
          aria-label="Search assets"
        />
        <select value={brand} onChange={(event) => setBrand(event.target.value)} aria-label="Filter by brand">
          <option value="all">All brands</option>
          {brands.map(([slug, name]) => <option value={slug} key={slug}>{name}</option>)}
        </select>
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filter by type">
          <option value="all">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="raw">Raw</option>
          <option value="ready">Ready</option>
          <option value="needs_metadata">Needs metadata</option>
          <option value="failed">Failed</option>
        </select>
        <div className="muted asset-result-count">{filtered.length} shown</div>
      </div>

      <div className="asset-grid">
        {filtered.map((asset) => (
          <Link href={`/assets/${asset.id}`} className="asset-tile" key={asset.id}>
            <div className={`asset-preview asset-preview-${asset.kind}`}>
              {asset.sourceType === "dropbox" && asset.sourcePath ? (
                <AssetThumbnail
                  sourcePath={asset.sourcePath}
                  kind={asset.kind}
                  filename={asset.filename}
                />
              ) : (
                <>
                  <span className="asset-preview-glyph">{kindGlyph(asset.kind)}</span>
                  <span>{asset.kind}</span>
                </>
              )}
              {asset.kind === "video" && <span className="asset-video-badge">▶</span>}
            </div>
            <div className="asset-tile-body">
              <div className="asset-filename" title={asset.filename}>{asset.filename}</div>
              <div className="asset-meta-row">
                <span>{asset.brandName}</span>
                <span>{formatBytes(asset.fileSizeBytes)}</span>
              </div>
              <div className="asset-path" title={asset.sourcePath || ""}>{asset.sourcePath || "Dropbox"}</div>
              <div className="asset-chip-row">
                <span className="status-chip">{asset.approvalStatus || "—"}</span>
                <span className="asset-small-chip">{asset.ingestStatus || "—"}</span>
                <span className="asset-small-chip">{asset.sourceType || "—"}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <strong>No assets match those filters.</strong>
          <p className="muted">Clear a filter or search term to see the indexed library.</p>
        </div>
      )}
    </>
  );
}
