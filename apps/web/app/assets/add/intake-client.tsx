"use client";

import { useMemo, useState } from "react";
import {
  completeDirectUploads,
  presignDirectUploads,
  type DirectUploadTicket
} from "@/lib/dev-api";

type IntakeFileStatus = "queued" | "uploading" | "uploaded" | "saved" | "ready" | "error";

type IntakeFile = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  status: IntakeFileStatus;
  progress: number;
  error?: string;
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

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

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
  }

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
      return;
    }

    setBusy(true);
    setMessage("");

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
          ? `Saved ${completed.created} assets as Raw.`
          : `Ingested ${completed.created} assets and marked them Ready.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
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
          Dump now, enrich later. Technical analysis happens automatically after ingest.
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
                  {["File", "Detected type", "Size", "Status"].map((label) => (
                    <th key={label} style={th}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id}>
                    <td style={td}>{file.name}</td>
                    <td style={td}>{file.type.startsWith("video/") ? "Video" : file.type.startsWith("image/") ? "Image" : file.type}</td>
                    <td style={td}>{(file.size / 1024 / 1024).toFixed(1)} MB</td>
                    <td style={td}>
                      <span className="status-chip">
                        {file.status === "queued" ? "Queued" :
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
          <div className="muted" style={{ fontSize: 13 }}>
            {message || (busy ? "Uploading directly to Brand OS storage…" : "Files upload directly to S3; large videos do not pass through Lambda.")}
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
