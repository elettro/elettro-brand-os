"use client";

import { useEffect, useState } from "react";
import { getAssetThumbnailUrl } from "@/lib/dev-api";

export type ThumbAsset = { filename: string; kind: string; sourcePath: string | null; title: string | null; durationMs: number | null };

// The thumbnail service runs ~10 at a time and answers 503 beyond that, so previews load
// through a small queue and retry with backoff; a week of posts asks for well over 100.
const THUMB_CONCURRENCY = 4;
const THUMB_RETRIES = 6;
let thumbsRunning = 0;
const thumbQueue: Array<() => void> = [];
function nextThumb() {
  while (thumbsRunning < THUMB_CONCURRENCY && thumbQueue.length) { thumbsRunning += 1; thumbQueue.shift()!(); }
}
function loadImage(src: string) {
  return new Promise<void>((resolve, reject) => {
    thumbQueue.push(() => {
      const img = new Image();
      const finish = (ok: boolean) => { thumbsRunning -= 1; nextThumb(); if (ok) resolve(); else reject(Error("thumbnail")); };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = src;
    });
    nextThumb();
  });
}

export function AssetThumb({ asset, size = 120 }: { asset: ThumbAsset; size?: number }) {
  const url = getAssetThumbnailUrl(asset.sourcePath, asset.kind);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < THUMB_RETRIES && !cancelled; i += 1) {
        // A fresh query string per try so the browser does not reuse the failed response.
        const tryUrl = i || attempt ? `${url}&try=${attempt}-${i}` : url;
        try {
          await loadImage(tryUrl);
          if (!cancelled) { setSrc(tryUrl); setFailed(false); }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 800 * 2 ** i));
        }
      }
      if (!cancelled) setFailed(true);
    })();
    return () => { cancelled = true; };
  }, [url, attempt]);
  return <div className="review-thumb" style={{ width: size, height: size * 16 / 9 }} title={asset.filename}>
    {src ? <img src={src} alt={asset.title || asset.filename} />
      : !url ? <span>{asset.kind}</span>
      : failed ? <button type="button" className="review-thumb-retry" onClick={() => { setFailed(false); setAttempt(attempt + 1); }}>Preview failed · Retry</button>
      : <span>Loading preview…</span>}
    {asset.durationMs ? <em>{Math.round(asset.durationMs / 1000)}s</em> : null}
  </div>;
}
