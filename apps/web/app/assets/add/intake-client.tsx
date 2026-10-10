"use client";

import { useEffect, useMemo, useState } from "react";
import {
  completeDirectUploads,
  presignDirectUploads,
  type DirectUploadTicket,
  getAssets
} from "@/lib/dev-api";

type IntakeFileStatus = "queued" | "analyzing" | "analyzed" | "uploading" | "uploaded" | "saved" | "ready" | "error";

type IntakeFile = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  status: IntakeFileStatus;
  progress: number;
  error?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatioLabel?: string;
  recommendedFolder?: string;
  recommendationConfidence?: number;
  recommendationReason?: string;
};

const networks = ["Instagram", "Facebook", "TikTok", "YouTube", "LinkedIn", "X"];

export function IntakeClient() {
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [brand, setBrand] = useState("stashbox");
  const [collection, setCollection] = useState("");
  const [campaign, setCampaign] = useState("");
  const [topic, setTopic] = useState("");
  const [creativeFamily, setCreativeFamily] = useState("");
  const [eligibilityMode, setEligibilityMode] = useState<"evergreen" | "window">("evergreen");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [repeatAnnually, setRepeatAnnually] = useState(false);
  const [sendToApprovalQueue, setSendToApprovalQueue] = useState(false);
  const [priority, setPriority] = useState("normal");
  const [creatorNote, setCreatorNote] = useState("");
  const [selectedNetworks, setSelectedNetworks] = useState(networks);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"idle" | "success" | "error">("idle");
  const [folderInventory, setFolderInventory] = useState<Array<{ path: string; count: number }>>([]);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

  useEffect(() => {
    let active = true;
    getAssets()
      .then((response) => {
        if (!active) return;
        const counts = new Map<string, number>();
        for (const asset of response.assets || []) {
          if (asset.brandSlug !== brand || !asset.sourcePath) continue;
          const normalized = asset.sourcePath.replace(/\\/g, "/");
          const lastSlash = normalized.lastIndexOf("/");
          if (lastSlash <= 0) continue;
          const folder = normalized.slice(0, lastSlash);
          counts.set(folder, (counts.get(folder) || 0) + 1);
        }
        setFolderInventory(
          [...counts.entries()]
            .map(([path, count]) => ({ path, count }))
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        );
      })
      .catch(() => {
        if (active) setFolderInventory([]);
      });
    return () => { active = false; };
  }, [brand]);

  function ratioLabel(width?: number, height?: number) {
    if (!width || !height) return undefined;
    const ratio = width / height;
    if (Math.abs(ratio - 9 / 16) < 0.06) return "9:16";
    if (Math.abs(ratio - 16 / 9) < 0.08) return "16:9";
    if (Math.abs(ratio - 1) < 0.06) return "1:1";
    if (Math.abs(ratio - 4 / 5) < 0.06) return "4:5";
    if (Math.abs(ratio - 3 / 2) < 0.08) return "3:2";
    return ratio > 1 ? "Landscape" : "Portrait";
  }

  function tokenize(value: string) {
    return value
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !["the","and","with","from","final","copy","video","image"].includes(token));
  }

  function recommendFolder(item: IntakeFile) {
    if (!folderInventory.length) return {} as Partial<IntakeFile>;
    const terms = new Set([
      ...tokenize(item.name),
      ...tokenize(collection),
      ...tokenize(campaign),
      ...tokenize(topic),
      ...tokenize(creativeFamily),
      ...(item.aspectRatioLabel ? [item.aspectRatioLabel.toLowerCase().replace(":", "x")] : [])
    ]);
    let best: { path: string; count: number; score: number } | null = null;
    for (const folder of folderInventory) {
      const pathTerms = new Set(tokenize(folder.path.replace(/\//g, " ")));
      let matched = 0;
      for (const term of terms) if (pathTerms.has(term)) matched += 1;
      const kindBonus = item.type.startsWith("video/") && /\/videos?\b/i.test(folder.path) ? 1.5 : item.type.startsWith("image/") && /\/images?\b/i.test(folder.path) ? 1.5 : 0;
      const ratioBonus = item.aspectRatioLabel === "9:16" && /(9x16|9-16|vertical|shorts?|reels?)/i.test(folder.path) ? 2 : item.aspectRatioLabel === "16:9" && /(16x9|16-9|horizontal|youtube)/i.test(folder.path) ? 2 : 0;
      const score = matched * 3 + kindBonus + ratioBonus + Math.min(2, Math.log10(folder.count + 1));
      if (!best || score > best.score) best = { ...folder, score };
    }
    if (!best || best.score < 4) return {} as Partial<IntakeFile>;
    return {
      recommendedFolder: best.path,
      recommendationConfidence: Math.min(96, Math.round(54 + best.score * 5)),
      recommendationReason: "Based on " + best.count + " existing asset" + (best.count === 1 ? "" : "s") + " in this folder"
    };
  }

  async function analyzeFile(item: IntakeFile) {
    updateFile(item.id, { status: "analyzing", error: undefined });
    try {
      let width: number | undefined;
      let height: number | undefined;
      let durationSeconds: number | undefined;
      const url = URL.createObjectURL(item.file);
      try {
        if (item.type.startsWith("video/")) {
          const metadata = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : 0 });
            video.onerror = () => reject(new Error("Could not read video metadata"));
            video.src = url;
          });
          width = metadata.width; height = metadata.height; durationSeconds = metadata.duration;
        } else if (item.type.startsWith("image/")) {
          const metadata = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => reject(new Error("Could not read image metadata"));
            image.src = url;
          });
          width = metadata.width; height = metadata.height;
        }
      } finally { URL.revokeObjectURL(url); }
      const analyzed: IntakeFile = { ...item, width, height, durationSeconds, aspectRatioLabel: ratioLabel(width, height), status: "analyzed" };
      updateFile(item.id, { ...analyzed, ...recommendFolder(analyzed) });
    } catch (error) {
      updateFile(item.id, { status: "analyzed", error: error instanceof Error ? error.message : "Quick analysis unavailable" });
    }
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const additions = Array.from(list).map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      status: "queued" as IntakeFileStatus,
      progress: 0
    }));
    setFiles((current) => [...current, ...additions]);
    for (const item of additions) void analyzeFile(item);
    setMessage("");
    setMessageTone("idle");
  }

  useEffect(() => {
    if (!files.length) return;
    setFiles((current) => current.map((item) => {
      if (item.status === "analyzing") return item;
      const recommendation = recommendFolder(item);
      return {
        ...item,
        recommendedFolder: recommendation.recommendedFolder,
        recommendationConfidence: recommendation.recommendationConfidence,
        recommendationReason: recommendation.recommendationReason
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderInventory, collection, campaign, topic, creativeFamily]);

  function toggleNetwork(name: string) {
    setSelectedNetworks((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    );
  }

  function updateFile(id: string, patch: Partial<IntakeFile>) {
    setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  function removeFile(id: string) {
    if (busy) return;
    setFiles((current) => current.filter((item) => item.id !== id));
    setMessage("");
    setMessageTone("idle");
  }

  function uploadFileToS3(item: IntakeFile, ticket: DirectUploadTicket) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", ticket.uploadUrl);
      xhr.setRequestHeader("Content-Type", ticket.contentType || "application/octet-stream");

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        updateFile(item.id, {
          status: "uploading",
          progress: Math.round((event.loaded / event.total) * 100)
        });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          updateFile(item.id, { status: "uploaded", progress: 100, error: undefined });
          resolve();
        } else {
          reject(new Error(`S3 upload failed (${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error("S3 upload failed"));
      xhr.send(item.file);
    });
  }

  async function uploadWithConcurrency(
    items: Array<{ item: IntakeFile; ticket: DirectUploadTicket }>,
    limit = 3
  ) {
    let cursor = 0;

    async function worker() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const current = items[index];
        try {
          await uploadFileToS3(current.item, current.ticket);
        } catch (error) {
          updateFile(current.item.id, {
            status: "error",
            error: error instanceof Error ? error.message : "Upload failed"
          });
          throw error;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker())
    );
  }

  async function submitBatch(mode: "raw" | "ready") {
    if (!files.length || busy) return;

    if (eligibilityMode === "window" && (!windowStart || !windowEnd)) {
      setMessage("Choose both a start and stop date for a publishing window.");
      setMessageTone("error");
      return;
    }

    setBusy(true);
    setMessage("");
    setMessageTone("idle");

    try {
      setFiles((current) =>
        current.map((item) => ({
          ...item,
          status: "queued",
          progress: 0,
          error: undefined
        }))
      );

      const presigned = await presignDirectUploads({
        brandSlug: brand,
        files: files.map((item) => ({
          name: item.name,
          type: item.type,
          size: item.size
        }))
      });

      if (presigned.uploads.length !== files.length) {
        throw new Error("Upload ticket count did not match selected files.");
      }

      await uploadWithConcurrency(
        files.map((item, index) => ({
          item,
          ticket: presigned.uploads[index]
        }))
      );

      const completed = await completeDirectUploads({
        brandSlug: brand,
        mode,
        files: presigned.uploads.map((ticket, index) => ({
          key: ticket.key,
          name: files[index].name,
          type: files[index].type,
          size: files[index].size
        })),
        metadata: {
          collection,
          campaign,
          topic,
          creativeFamily,
          eligibilityMode,
          windowStart,
          windowEnd,
          repeatAnnually,
          sendToApprovalQueue,
          priority,
          creatorNote,
          allowedDestinations: selectedNetworks
        }
      });

      const finalStatus: IntakeFileStatus = mode === "raw" ? "saved" : "ready";
      setFiles((current) =>
        current.map((item) => ({
          ...item,
          status: finalStatus,
          progress: 100,
          error: undefined
        }))
      );
      setMessage(
        mode === "raw"
          ? `${completed.created} asset${completed.created === 1 ? "" : "s"} saved successfully.`
          : `${completed.created} asset${completed.created === 1 ? "" : "s"} saved and marked Ready.`
      );
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      <section
        className="card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}
        style={{ borderStyle: "dashed", padding: 30, textAlign: "center" }}
      >
        <h2 style={{ marginTop: 0 }}>Drop assets here</h2>
        <p className="muted">
          Files are staged first. Quick technical analysis starts immediately and can suggest where similar assets already live.
        </p>
        <label style={{ display: "inline-block", marginTop: 8, cursor: "pointer" }}>
          <span className="status-chip">Choose files</span>
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={(event) => addFiles(event.target.files)}
            style={{ display: "none" }}
          />
        </label>
      </section>

      <section className="card">
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <div className="eyebrow">Batch defaults</div>
            <h2 style={{ margin: "4px 0 0" }}>Apply once to the whole group</h2>
          </div>
          <div className="muted">{files.length} files · {(totalSize / 1024 / 1024).toFixed(1)} MB</div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <Field label="Brand">
            <select value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="stashbox">Stashbox</option>
              <option value="solarmeister">SolarMeister</option>
              <option value="weightlossdavie">WeightLossDavie</option>
              <option value="neckermann-strom">Neckermann Strom</option>
              <option value="therasbox">Therasbox</option>
              <option value="elettro">Elettro</option>
            </select>
          </Field>
          <Field label="Collection">
            <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="e.g. Stashbox Does Sublime" />
          </Field>
          <Field label="Campaign">
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Topic / Product">
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Creative Family">
            <input value={creativeFamily} onChange={(e) => setCreativeFamily(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Availability">
            <select
              value={eligibilityMode}
              onChange={(e) => setEligibilityMode(e.target.value as "evergreen" | "window")}
            >
              <option value="evergreen">Evergreen / always available</option>
              <option value="window">Start + stop date window</option>
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </Field>
          <Field label="Creator Note">
            <input value={creatorNote} onChange={(e) => setCreatorNote(e.target.value)} placeholder="e.g. Strong booking clips, favor these" />
          </Field>
        </div>

        {eligibilityMode === "window" && (
          <div className="card" style={{ marginTop: 18, background: "var(--panel-soft)" }}>
            <div className="eyebrow">Publishing window</div>
            <h3 style={{ margin: "5px 0 12px" }}>When is this content allowed to run?</h3>
            <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
              <Field label="Start date">
                <input type="date" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
              </Field>
              <Field label="Stop date">
                <input type="date" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </Field>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <input
                type="checkbox"
                checked={repeatAnnually}
                onChange={(e) => setRepeatAnnually(e.target.checked)}
              />
              <span>
                <strong>Repeat this window every year</strong>
                <span className="muted" style={{ display: "block" }}>
                  Checked = annual seasonal content. Unchecked = one-time date window.
                </span>
              </span>
            </label>
            {repeatAnnually && windowStart && windowEnd && (
              <div className="status-chip" style={{ marginTop: 12 }}>
                Annual window · {windowStart.slice(5)} → {windowEnd.slice(5)}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={sendToApprovalQueue}
              onChange={(e) => setSendToApprovalQueue(e.target.checked)}
            />
            <span>
              <strong>Send to approval queue</strong>
              <span className="muted" style={{ display: "block" }}>
                Default is unchecked. Assets are approved immediately unless this is selected.
              </span>
            </span>
          </label>

          <div className="metric" style={{ marginBottom: 8 }}>Allowed destinations</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {networks.map((network) => (
              <button
                type="button"
                key={network}
                onClick={() => toggleNetwork(network)}
                className="status-chip"
                style={{
                  border: "1px solid var(--line)",
                  cursor: "pointer",
                  opacity: selectedNetworks.includes(network) ? 1 : .4
                }}
              >
                {network}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <div className="eyebrow">Files</div>
            <h2 style={{ margin: "4px 0 0" }}>Individual differences stay individual</h2>
          </div>
        </div>

        {files.length === 0 ? (
          <p className="muted">No files selected yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["File", "Quick analysis", "Size", "Recommended folder", "Status"].map((label) => (
                    <th key={label} style={th}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <button
                          type="button"
                          aria-label={`Remove ${file.name}`}
                          title="Remove from this batch"
                          disabled={busy}
                          onClick={() => removeFile(file.id)}
                          style={{
                            flex: "0 0 auto",
                            border: "1px solid var(--line)",
                            background: "white",
                            color: "#b42318",
                            borderRadius: 999,
                            width: 30,
                            height: 30,
                            lineHeight: "26px",
                            fontSize: 19,
                            fontWeight: 700,
                            cursor: busy ? "not-allowed" : "pointer"
                          }}
                        >
                          ×
                        </button>
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{file.name}</span>
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>{file.type.startsWith("video/") ? "Video" : file.type.startsWith("image/") ? "Image" : file.type}</div>
                      {file.status === "analyzing" ? (
                        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>Analyzing…</div>
                      ) : (
                        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                          {file.width && file.height ? file.width + "×" + file.height : "Dimensions unavailable"}
                          {file.aspectRatioLabel ? " · " + file.aspectRatioLabel : ""}
                          {typeof file.durationSeconds === "number" && file.durationSeconds > 0
                            ? " · " + Math.floor(file.durationSeconds / 60) + ":" + String(Math.round(file.durationSeconds % 60)).padStart(2, "0")
                            : ""}
                        </div>
                      )}
                    </td>
                    <td style={td}>{(file.size / 1024 / 1024).toFixed(1)} MB</td>
                    <td style={{ ...td, minWidth: 240 }}>
                      {file.status === "analyzing" ? (
                        <span className="muted">Analyzing…</span>
                      ) : file.recommendedFolder ? (
                        <div>
                          <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{file.recommendedFolder}</div>
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                            {file.recommendationConfidence}% confidence
                            {file.recommendationReason ? " · " + file.recommendationReason : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="muted">No confident recommendation</span>
                      )}
                    </td>
                    <td style={td}>
                      <span className="status-chip">
                        {file.status === "queued" ? "Queued" :
                         file.status === "analyzing" ? "Analyzing" :
                         file.status === "analyzed" ? "Suggestions Ready" :
                         file.status === "uploading" ? `Uploading ${file.progress}%` :
                         file.status === "uploaded" ? "Uploaded" :
                         file.status === "saved" ? "Raw · Saved" :
                         file.status === "ready" ? "Ready" : "Error"}
                      </span>
                      {file.error && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#b42318" }}>{file.error}</div>
                      )}
                    </td>

                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 18 }}>
          <div
            aria-live="polite"
            style={{
              fontSize: 13,
              fontWeight: messageTone === "success" ? 700 : 500,
              color:
                messageTone === "success"
                  ? "#067647"
                  : messageTone === "error"
                    ? "#b42318"
                    : "var(--muted)"
            }}
          >
            {message
              ? messageTone === "success"
                ? `✓ ${message}`
                : message
              : busy
                ? "Uploading directly to Brand OS storage…"
                : files.length
                  ? `${files.length} asset${files.length === 1 ? "" : "s"} selected · not saved yet`
                  : "Select files to stage them here before saving."}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button
              type="button"
              disabled={!files.length || busy}
              onClick={() => submitBatch("raw")}
              style={buttonSecondary}
            >
              {busy ? "Uploading…" : "Save Raw"}
            </button>
            <button
              type="button"
              disabled={!files.length || busy}
              onClick={() => submitBatch("ready")}
              style={buttonPrimary}
            >
              {busy ? "Uploading…" : "Ingest & Ready"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span className="metric">{label}</span>
      <div className="intake-control">{children}</div>
    </label>
  );
}

const th = { textAlign: "left" as const, padding: "10px 8px", borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--muted)" };
const td = { padding: "12px 8px", borderBottom: "1px solid var(--line)", fontSize: 14 };
const buttonPrimary = { border: 0, borderRadius: 9, padding: "10px 14px", background: "var(--accent)", color: "white", fontWeight: 700, cursor: "pointer" };
const buttonSecondary = { border: "1px solid var(--line)", borderRadius: 9, padding: "10px 14px", background: "white", color: "var(--text)", fontWeight: 700, cursor: "pointer" };
