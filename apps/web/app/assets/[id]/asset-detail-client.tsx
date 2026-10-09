"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  bulkUpdateAssets,
  getAssetThumbnailUrl,
  type ApiAsset,
  type BulkAssetMetadata
} from "@/lib/dev-api";

const DESTINATIONS = ["instagram", "facebook", "tiktok", "youtube", "threads", "x", "website", "rss"];

function mmddToInput(value?: number | null) {
  if (!value) return "";
  const s = String(value).padStart(4, "0");
  return `${s.slice(0,2)}-${s.slice(2)}`;
}

function inputToMmdd(value: string) {
  if (!value) return null;
  return Number(value.replace("-", ""));
}

export function AssetDetailClient({ asset }: { asset: ApiAsset }) {
  const initialDisplayTitle = asset.title || asset.filename;
  const [title, setTitle] = useState(initialDisplayTitle);
  const [editingTitle, setEditingTitle] = useState(false);
  const [topic, setTopic] = useState(asset.topic || "");
  const [contentGroup, setContentGroup] = useState(asset.contentGroup || "");
  const [creativeFamily, setCreativeFamily] = useState(asset.creativeFamily || "");
  const [creativeNotes, setCreativeNotes] = useState(asset.creativeNotes || "");
  const [tags, setTags] = useState<string[]>(asset.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [priority, setPriority] = useState(asset.priority || "normal");
  const [eligibilityType, setEligibilityType] = useState<"evergreen" | "annual" | "one_time">(
    (asset.eligibilityType as "evergreen" | "annual" | "one_time") || "evergreen"
  );
  const [eligibleFrom, setEligibleFrom] = useState(asset.eligibleFrom?.slice(0,10) || "");
  const [eligibleUntil, setEligibleUntil] = useState(asset.eligibleUntil?.slice(0,10) || "");
  const [annualFrom, setAnnualFrom] = useState(mmddToInput(asset.annualFromMmdd));
  const [annualUntil, setAnnualUntil] = useState(mmddToInput(asset.annualUntilMmdd));
  const [containsSpecificPricing, setContainsSpecificPricing] = useState(Boolean(asset.containsSpecificPricing));
  const [allowedDestinations, setAllowedDestinations] = useState<string[]>(asset.allowedDestinations || []);
  const [excludedDestinations, setExcludedDestinations] = useState<string[]>(asset.excludedDestinations || []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!previewOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewOpen]);

  const thumbnail = getAssetThumbnailUrl(asset.sourcePath, asset.kind);

  const allDestinationsAllowed = DESTINATIONS.every((destination) => allowedDestinations.includes(destination));
  const allDestinationsExcluded = DESTINATIONS.every((destination) => excludedDestinations.includes(destination));

  const toggleAllDestinations = (mode: "allow" | "exclude") => {
    if (mode === "allow") {
      if (allDestinationsAllowed) {
        setAllowedDestinations([]);
      } else {
        setAllowedDestinations([...DESTINATIONS]);
        setExcludedDestinations([]);
      }
      return;
    }

    if (allDestinationsExcluded) {
      setExcludedDestinations([]);
    } else {
      setExcludedDestinations([...DESTINATIONS]);
      setAllowedDestinations([]);
    }
  };

  const toggleDestination = (value: string, mode: "allow" | "exclude") => {
    if (mode === "allow") {
      setAllowedDestinations((current) =>
        current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      );
      if (!allowedDestinations.includes(value)) {
        setExcludedDestinations((current) => current.filter((item) => item !== value));
      }
    } else {
      setExcludedDestinations((current) =>
        current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      );
      if (!excludedDestinations.includes(value)) {
        setAllowedDestinations((current) => current.filter((item) => item !== value));
      }
    }
  };

  const tagCharacterCount = tags.join(", ").length;

  const addTags = (raw: string) => {
    const candidates = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (!candidates.length) return;

    setTags((current) => {
      const next = [...current];

      for (const candidate of candidates) {
        const exists = next.some((tag) => tag.toLowerCase() === candidate.toLowerCase());
        if (exists) continue;

        const proposed = [...next, candidate].join(", ");
        if (proposed.length > 500) break;
        next.push(candidate);
      }

      return next;
    });

    setTagInput("");
  };

  const removeTag = (tagToRemove: string) => {
    setTags((current) => current.filter((tag) => tag !== tagToRemove));
  };

  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTags(tagInput);
      return;
    }

    if (event.key === "Backspace" && !tagInput && tags.length) {
      event.preventDefault();
      setTags((current) => current.slice(0, -1));
    }
  };

  const save = async (markReady = false) => {
    setBusy(true);
    setMessage("");

    try {
      const metadata: BulkAssetMetadata = {
        title: title.trim() === asset.filename && !asset.title ? null : title.trim() || null,
        topic: topic || null,
        contentGroup: contentGroup || null,
        creativeFamily: creativeFamily || null,
        creativeNotes: creativeNotes || null,
        tags,
        priority,
        eligibilityType: containsSpecificPricing ? "one_time" : eligibilityType,
        containsSpecificPricing,
        allowedDestinations,
        excludedDestinations,
        eligibleFrom: eligibilityType === "one_time" || containsSpecificPricing ? eligibleFrom || null : null,
        eligibleUntil: eligibilityType === "one_time" || containsSpecificPricing ? eligibleUntil || null : null,
        annualFromMmdd: eligibilityType === "annual" && !containsSpecificPricing ? inputToMmdd(annualFrom) : null,
        annualUntilMmdd: eligibilityType === "annual" && !containsSpecificPricing ? inputToMmdd(annualUntil) : null
      };

      const result = await bulkUpdateAssets({
        assetIds: [asset.id],
        metadata,
        markReady
      });

      setMessage(markReady ? "Saved and marked ready." : `Saved ${result.updated} asset.`);
      if (markReady) setTimeout(() => window.location.href = "/content-pool", 700);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="main">
      <div className="topbar">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="eyebrow">Asset Review</div>

          {editingTitle ? (
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setEditingTitle(false);
                }
                if (event.key === "Escape") {
                  setTitle(initialDisplayTitle);
                  setEditingTitle(false);
                }
              }}
              placeholder={asset.filename}
              aria-label="Asset display title"
              style={{
                width: "100%",
                maxWidth: 1100,
                boxSizing: "border-box",
                fontSize: "clamp(32px, 3.2vw, 56px)",
                lineHeight: 1.08,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: "inherit",
                background: "white",
                border: "2px solid var(--accent)",
                borderRadius: 10,
                padding: "6px 10px",
                outline: "none"
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Click to edit display title"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                width: "100%",
                maxWidth: 1100,
                textAlign: "left",
                border: 0,
                padding: 0,
                margin: 0,
                background: "transparent",
                color: "inherit",
                cursor: "text"
              }}
            >
              <h1 style={{ margin: 0, overflowWrap: "anywhere" }}>
                {title.trim() || asset.filename}
              </h1>
              <span
                aria-hidden="true"
                style={{
                  flex: "0 0 auto",
                  marginTop: 10,
                  fontSize: 18,
                  color: "var(--muted)"
                }}
              >
                ✎
              </span>
            </button>
          )}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginTop: 14,
              marginBottom: 8
            }}
          >
            <div
              title="Brand"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 9,
                minHeight: 42,
                padding: "7px 12px",
                borderRadius: 12,
                border: "1px solid var(--line)",
                background: "var(--panel-soft)",
                boxShadow: "0 1px 2px rgba(0,0,0,.05)"
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 27,
                  height: 27,
                  borderRadius: 8,
                  background: "var(--accent)",
                  color: "white",
                  fontWeight: 900,
                  fontSize: 12
                }}
              >
                {asset.brandName?.slice(0, 1).toUpperCase() || "B"}
              </span>
              <span style={{ display: "grid", lineHeight: 1.05 }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--muted)" }}>
                  Brand
                </span>
                <strong style={{ fontSize: 14 }}>{asset.brandName}</strong>
              </span>
            </div>

            <div
              title="Media type"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                minHeight: 42,
                padding: "7px 12px",
                borderRadius: 12,
                border: "1px solid var(--line)",
                background: "white",
                boxShadow: "0 1px 2px rgba(0,0,0,.05)"
              }}
            >
              <span style={{ fontSize: 16 }}>{asset.kind === "video" ? "▶" : asset.kind === "image" ? "▣" : "▦"}</span>
              <span style={{ display: "grid", lineHeight: 1.05 }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--muted)" }}>
                  Media
                </span>
                <strong style={{ fontSize: 14, textTransform: "capitalize" }}>{asset.kind}</strong>
              </span>
            </div>

            <div
              title="Aspect ratio"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                minHeight: 42,
                padding: "7px 12px",
                borderRadius: 12,
                border: "1px solid var(--line)",
                background: "white",
                boxShadow: "0 1px 2px rgba(0,0,0,.05)"
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 22,
                  borderRadius: 3,
                  border: "2px solid currentColor",
                  opacity: .7
                }}
              />
              <span style={{ display: "grid", lineHeight: 1.05 }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: "var(--muted)" }}>
                  Format
                </span>
                <strong style={{ fontSize: 14 }}>
                  {asset.aspectRatioLabel || asset.folderSuggestions?.aspectRatioLabel || "Unknown"}
                </strong>
              </span>
            </div>
          </div>

          <p className="muted" style={{ marginTop: 0, overflowWrap: "anywhere", fontSize: 12 }}>
            Original file: {asset.filename}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="status-chip" href="/assets/needs-metadata">Needs Metadata</Link>
          <Link className="status-chip" href="/assets">Asset Library</Link>
        </div>
      </div>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(260px,420px) minmax(0,1fr)", gap: 20, marginTop: 20, alignItems: "start" }}>
        <div className="card">
          <div style={{ minHeight: 320, maxHeight: 560, display: "grid", placeItems: "center", background: "var(--panel-soft)", borderRadius: 12, overflow: "hidden" }}>
            {thumbnail ? (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                aria-label={`Open large preview for ${asset.filename}`}
                style={{
                  border: 0,
                  padding: 0,
                  margin: 0,
                  background: "transparent",
                  cursor: "zoom-in",
                  display: "grid",
                  placeItems: "center",
                  width: "100%",
                  height: "100%"
                }}
              >
                <img
                  src={thumbnail}
                  alt={asset.filename}
                  style={{ maxWidth: "100%", maxHeight: 540, width: "auto", height: "auto", objectFit: "contain", display: "block" }}
                />
              </button>
            ) : <span className="muted">No preview available</span>}
          </div>

          <div style={{ display: "grid", gap: 6, marginTop: 14, fontSize: 13 }}>
            <div><strong>Status:</strong> {asset.ingestStatus} · {asset.enrichmentStatus} · {asset.approvalStatus}</div>
            <div><strong>Source:</strong> {asset.sourceType || "—"}</div>
            <div style={{ overflowWrap: "anywhere" }}><strong>Path:</strong> {asset.sourcePath || "—"}</div>
            <div><strong>Dimensions:</strong> {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}</div>
            <div><strong>Duration:</strong> {asset.durationMs ? `${Math.round(asset.durationMs / 1000)} sec` : "—"}</div>
          </div>
        </div>

        <section className="card">
          <div className="eyebrow">Per-asset override</div>
          <h2 style={{ marginTop: 4 }}>Metadata</h2>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginTop: 14 }}>
            <label className="intake-control">
              <span className="metric">Topic / subject</span>
              <input value={topic} onChange={(e) => setTopic(e.target.value)} />
            </label>

            <label className="intake-control">
              <span className="metric">Content group</span>
              <input value={contentGroup} onChange={(e) => setContentGroup(e.target.value)} />
            </label>

            <label className="intake-control">
              <span className="metric">Creative family</span>
              <input value={creativeFamily} onChange={(e) => setCreativeFamily(e.target.value)} />
            </label>

            <label className="intake-control">
              <span className="metric">Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="hero">Hero</option>
              </select>
            </label>

            <label className="intake-control">
              <span className="metric">Eligibility</span>
              <select
                value={containsSpecificPricing ? "one_time" : eligibilityType}
                onChange={(e) => setEligibilityType(e.target.value as "evergreen" | "annual" | "one_time")}
                disabled={containsSpecificPricing}
              >
                <option value="evergreen">Evergreen</option>
                <option value="annual">Annual window</option>
                <option value="one_time">One-time window</option>
              </select>
            </label>

            <label className="intake-control" style={{ alignContent: "end" }}>
              <span className="metric">Specific pricing / offer</span>
              <span style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 42 }}>
                <input type="checkbox" checked={containsSpecificPricing} onChange={(e) => setContainsSpecificPricing(e.target.checked)} />
                Force one-time eligibility
              </span>
            </label>
          </div>

          {(eligibilityType === "one_time" || containsSpecificPricing) && (
            <div className="grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 12 }}>
              <label className="intake-control">
                <span className="metric">Eligible from</span>
                <input type="date" value={eligibleFrom} onChange={(e) => setEligibleFrom(e.target.value)} />
              </label>
              <label className="intake-control">
                <span className="metric">Eligible until</span>
                <input type="date" value={eligibleUntil} onChange={(e) => setEligibleUntil(e.target.value)} />
              </label>
            </div>
          )}

          {eligibilityType === "annual" && !containsSpecificPricing && (
            <div className="grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", marginTop: 12 }}>
              <label className="intake-control">
                <span className="metric">Annual from</span>
                <input type="text" placeholder="09-15" value={annualFrom} onChange={(e) => setAnnualFrom(e.target.value)} />
              </label>
              <label className="intake-control">
                <span className="metric">Annual until</span>
                <input type="text" placeholder="12-25" value={annualUntil} onChange={(e) => setAnnualUntil(e.target.value)} />
              </label>
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <div className="metric" style={{ marginBottom: 8 }}>Destination rules</div>

            <div
              style={{
                display: "flex",
                gap: 18,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 10,
                paddingBottom: 10,
                borderBottom: "1px solid var(--line)"
              }}
            >
              <strong style={{ minWidth: 140 }}>All destinations</strong>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={allDestinationsAllowed}
                  onChange={() => toggleAllDestinations("allow")}
                />
                Select / deselect all Allow
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={allDestinationsExcluded}
                  onChange={() => toggleAllDestinations("exclude")}
                />
                Select / deselect all Exclude
              </label>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {DESTINATIONS.map((destination) => (
                <div key={destination} style={{ display: "grid", gridTemplateColumns: "140px 1fr 1fr", gap: 10, alignItems: "center" }}>
                  <strong style={{ textTransform: "capitalize" }}>{destination}</strong>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={allowedDestinations.includes(destination)}
                      onChange={() => toggleDestination(destination, "allow")}
                    />
                    Allow
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={excludedDestinations.includes(destination)}
                      onChange={() => toggleDestination(destination, "exclude")}
                    />
                    Exclude
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div className="metric" style={{ marginBottom: 8 }}>Tags</div>
            <div
              style={{
                minHeight: 54,
                width: "100%",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                padding: 10,
                border: "1px solid var(--line)",
                borderRadius: 10,
                background: "white",
                boxSizing: "border-box"
              }}
              onClick={(event) => {
                const input = event.currentTarget.querySelector("input");
                input?.focus();
              }}
            >
              {tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 8px",
                    borderRadius: 7,
                    background: "var(--panel-soft)",
                    border: "1px solid var(--line)",
                    fontSize: 13,
                    lineHeight: 1.2
                  }}
                >
                  {tag}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeTag(tag);
                    }}
                    aria-label={`Remove tag ${tag}`}
                    style={{
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      lineHeight: 1,
                      cursor: "pointer",
                      fontWeight: 800
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}

              <input
                value={tagInput}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.includes(",")) {
                    addTags(value);
                  } else {
                    setTagInput(value);
                  }
                }}
                onKeyDown={handleTagKeyDown}
                onBlur={() => {
                  if (tagInput.trim()) addTags(tagInput);
                }}
                placeholder={tags.length ? "Add tag" : "Add tags"}
                style={{
                  flex: "1 1 180px",
                  minWidth: 140,
                  border: 0,
                  outline: "none",
                  padding: "6px 2px",
                  background: "transparent"
                }}
              />
            </div>
            <div
              className="muted"
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 12
              }}
            >
              <span>Type a tag, then press Enter or comma. Backspace removes the previous tag.</span>
              <span>{tagCharacterCount}/500</span>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <label className="intake-control" style={{ display: "grid", gap: 8 }}>
              <span className="metric" style={{ display: "block" }}>Creative notes / intent</span>
              <textarea
                value={creativeNotes}
                onChange={(e) => setCreativeNotes(e.target.value)}
                rows={7}
                placeholder="Anything the publishing engine should know about this specific asset."
                style={{
                  width: "100%",
                  minHeight: 170,
                  resize: "vertical",
                  boxSizing: "border-box",
                  padding: 12,
                  lineHeight: 1.4
                }}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 18 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => save(false)}
              style={{ border: "1px solid var(--line)", background: "white", borderRadius: 9, padding: "10px 14px", fontWeight: 800, cursor: "pointer" }}
            >
              Save asset
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => save(true)}
              style={{ border: 0, background: "var(--accent)", color: "white", borderRadius: 9, padding: "10px 14px", fontWeight: 800, cursor: "pointer" }}
            >
              Save + Mark Ready
            </button>
            {message && <strong style={{ fontSize: 13 }}>{message}</strong>}
          </div>
        </section>
      </section>

      {previewOpen && thumbnail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Large preview for ${asset.filename}`}
          onClick={() => setPreviewOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "rgba(0,0,0,0.82)",
            cursor: "zoom-out"
          }}
        >
          <div
            style={{
              maxWidth: "94vw",
              maxHeight: "92vh",
              display: "grid",
              gap: 12,
              justifyItems: "center"
            }}
          >
            <img
              src={thumbnail}
              alt={asset.filename}
              style={{
                maxWidth: "94vw",
                maxHeight: "84vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                display: "block",
                borderRadius: 12,
                boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
                background: "#111"
              }}
            />
            <div
              style={{
                color: "#fff",
                fontSize: 13,
                textAlign: "center",
                maxWidth: "82vw",
                overflowWrap: "anywhere"
              }}
            >
              {asset.filename}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
