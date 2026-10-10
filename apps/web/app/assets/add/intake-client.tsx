"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DropboxFolderBrowser } from "./dropbox-folder-browser";
import { getAssets } from "@/lib/dev-api";

type IntakeFileStatus = "queued" | "analyzing" | "analyzed" | "uploading" | "uploaded" | "saved" | "ready" | "error";

type IntakeFile = {
  id: string;
  file: File;
  sha256?: string;
  name: string;
  type: string;
  size: number;
  status: IntakeFileStatus;
  progress: number;
  error?: string;
  dropboxUploadedPath?: string;
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
  const stagedHashes = useRef(new Set<string>());
  const [brand, setBrand] = useState("stashbox");
  const [plannedDropboxFolder, setPlannedDropboxFolder] = useState<string | null>(null);
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
  const [dropboxTestBusy, setDropboxTestBusy] = useState(false);
  const [dropboxTestResult, setDropboxTestResult] = useState("");
  const [uploadedDropboxPath, setUploadedDropboxPath] = useState<string | null>(null);
  const [registeringDropbox, setRegisteringDropbox] = useState(false);
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

  // Temporary same-browser persistent duplicate ledger. Backend canonical hash enforcement is still required.
  function savedFingerprintKey(brandSlug: string) { return `elettro:saved-sha256:v1:${brandSlug}`; }
  function getSavedFingerprints(brandSlug: string): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(savedFingerprintKey(brandSlug)) || "[]") as string[]); }
    catch { return new Set<string>(); }
  }
  function rememberSavedFingerprints(brandSlug: string, hashes: string[]) {
    const stored = getSavedFingerprints(brandSlug);
    hashes.forEach(hash => stored.add(hash));
    try { localStorage.setItem(savedFingerprintKey(brandSlug), JSON.stringify([...stored])); }
    catch { /* Browser storage unavailable. Server-side protection remains required. */ }
  }
  async function sha256(file: File): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function addFiles(list: FileList | null) {
    if (!list || busy) return;
    const incoming = await Promise.all(Array.from(list).map(async (file) => ({
      id: crypto.randomUUID(),
      file,
      sha256: await sha256(file),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      status: "queued" as IntakeFileStatus,
      progress: 0
    })));
    const accepted: IntakeFile[] = [];
    let skipped = 0;
    const previouslySaved = getSavedFingerprints(brand);
    let alreadySaved = 0;
    for (const item of incoming) {
      if (previouslySaved.has(item.sha256)) { skipped++; alreadySaved++; continue; }
      if (stagedHashes.current.has(item.sha256)) { skipped++; continue; }
      stagedHashes.current.add(item.sha256);
      accepted.push(item);
    }
    setFiles((current) => [...current, ...accepted]);
    for (const item of accepted) void analyzeFile(item);
    setMessage(skipped ? `${skipped} exact duplicate${skipped === 1 ? "" : "s"} skipped (${alreadySaved} previously saved in this browser). Full library protection across devices is pending.` : "");
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
    const removed = files.find((item) => item.id === id);
    if (removed?.sha256) stagedHashes.current.delete(removed.sha256);
    setFiles((current) => current.filter((item) => item.id !== id));
    setMessage("");
    setMessageTone("idle");
  }

  // DEV-only test: upload exactly one small image directly to a one-time Dropbox URL.
  // This intentionally does NOT mark an asset ingested/ready or touch S3.
  async function testDirectDropboxUpload() {
    if (!plannedDropboxFolder || files.length !== 1 || !files[0].type.startsWith("image/") || files[0].size > 10 * 1024 * 1024) {
      setDropboxTestResult("Select one image under 10 MB and a Dropbox destination first.");
      return;
    }
    setDropboxTestBusy(true);
    setDropboxTestResult("Requesting secure Dropbox upload link…");
    try {
      const item = files[0];
      const response = await fetch("/api/dropbox/upload-link", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand, path: plannedDropboxFolder, filename: item.name })
      });
      const info = await response.json();
      if (!response.ok || info.ok === false || !info.uploadUrl) {
        throw new Error(info.detail || info.error || "Unable to create Dropbox upload link");
      }
      setDropboxTestResult("Uploading image directly to Dropbox…");
      const uploaded = await fetch(info.uploadUrl, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: item.file
      });
      const resultText = await uploaded.text();
      if (!uploaded.ok) throw new Error("Dropbox upload failed (" + uploaded.status + "): " + resultText.slice(0, 220));
      setUploadedDropboxPath(String(info.path));
      setDropboxTestResult("Dropbox accepted the file at " + String(info.path) + ". Next, register it in Brand OS.");
    } catch (error) {
      setDropboxTestResult("Direct Dropbox test failed: " + (error instanceof Error ? error.message : "Unknown error"));
    } finally { setDropboxTestBusy(false); }
  }

  // Register only after a separately verified direct Dropbox upload; never send file contents through S3.
  async function testDropboxRegistration() {
    if (!uploadedDropboxPath || registeringDropbox) return;
    setRegisteringDropbox(true);
    try {
      const response = await fetch("/api/assets/bulk-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete-dropbox-upload", brandSlug: brand, path: uploadedDropboxPath, mode: "ready", metadata: {
          collection, campaign, topic, creativeFamily, eligibilityMode, windowStart, windowEnd,
          repeatAnnually, sendToApprovalQueue, priority, creatorNote, allowedDestinations: selectedNetworks
        }})
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || data.detail || "Registration failed");
      setDropboxTestResult(data.alreadyRegistered
        ? "This Dropbox file already exists in Brand OS (asset ID: " + data.asset?.id + "). No duplicate created."
        : "Registered in Brand OS: asset ID " + data.asset?.id + " · " + data.asset?.ingestStatus + " · " + data.asset?.approvalStatus + ". Dropbox ID: " + data.dropboxFileId);
      updateFile(files[0].id, {status:"ready", progress:100, error:undefined, dropboxUploadedPath: uploadedDropboxPath});
      if(files[0].sha256)rememberSavedFingerprints(brand,[files[0].sha256]);
      setUploadedDropboxPath(null);
    } catch(error){setDropboxTestResult("Dropbox upload succeeded, but Brand OS registration failed: " + (error instanceof Error ? error.message : "Unknown error") + ". Do not upload this file again.");}
    finally {setRegisteringDropbox(false);}
  }

  // DEV direct Dropbox intake. Unsupported large uploads STOP; there is no S3 fallback.
  async function submitBatch(mode: "raw" | "ready") {
    if (busy || dropboxTestBusy || registeringDropbox || files.length === 0) return;
    if (!plannedDropboxFolder) {
      setMessage("Select a Dropbox destination folder before saving.");
      setMessageTone("error");
      return;
    }
    if (eligibilityMode === "window" && (!windowStart || !windowEnd)) {
      setMessage("Choose both publishing window dates.");
      setMessageTone("error");
      return;
    }
    const unsaved = files.filter(item => item.status !== "saved" && item.status !== "ready");
    if (!unsaved.length) {
      setMessage("These files are already registered; no files need saving.");
      setMessageTone("idle");
      return;
    }
    const unsupported = unsaved.find(item => !item.type.startsWith("image/") || item.size > 10 * 1024 * 1024);
    if (unsupported) {
      setMessage("Dropbox direct intake currently supports images up to 10 MB only. Large-file and video upload sessions are next. No S3 fallback was used.");
      setMessageTone("error");
      return;
    }
    setBusy(true);
    setMessageTone("idle");
    setMessage("Beginning direct Dropbox intake, without S3…");
    let count = 0;
    try {
      const seen = new Set<string>();
      for (const item of unsaved) {
        const hash = item.sha256 || await sha256(item.file);
        if (seen.has(hash)) continue;
        seen.add(hash);
        let uploadedPath = item.dropboxUploadedPath || (files.length === 1 ? uploadedDropboxPath : null);
        if (!uploadedPath) {
          if (getSavedFingerprints(brand).has(hash)) {
            updateFile(item.id, { status: "error", error: "Previously saved in this browser; skipped to avoid a duplicate." });
            continue;
          }
          updateFile(item.id, { status: "uploading", error: undefined, progress: 0 });
          setMessage("Uploading " + item.name + " directly to Dropbox…");
          const linkResponse = await fetch("/api/dropbox/upload-link", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ brand, path: plannedDropboxFolder, filename: item.name })
          });
          const link = await linkResponse.json();
          if (!linkResponse.ok || link.ok === false || !link.uploadUrl || !link.path) {
            throw new Error("Upload link for " + item.name + ": " + (link.detail || link.error || "Unavailable"));
          }
          const transfer = await fetch(link.uploadUrl, { method: "POST",
            headers: { "content-type": "application/octet-stream" }, body: item.file });
          if (!transfer.ok) {
            const detail = await transfer.text();
            throw new Error("Dropbox rejected " + item.name + " (" + transfer.status + "): " + detail.slice(0, 180));
          }
          uploadedPath = String(link.path);
          updateFile(item.id, { status: "uploaded", progress: 100, dropboxUploadedPath: uploadedPath });
        }
        setMessage("Verifying and registering " + item.name + " in Brand OS…");
        const response = await fetch("/api/assets/bulk-update", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "complete-dropbox-upload", brandSlug: brand, path: uploadedPath, mode,
            metadata: { collection, campaign, topic, creativeFamily, eligibilityMode, windowStart, windowEnd,
              repeatAnnually, sendToApprovalQueue, priority, creatorNote, allowedDestinations: selectedNetworks } })
        });
        const result = await response.json();
        if (!response.ok || result.ok === false || !result.asset?.id) {
          throw new Error("Dropbox has " + item.name + ", but registration failed: " + (result.detail || result.error || "Unknown error") + ". Retry without uploading again.");
        }
        updateFile(item.id, { status: mode === "ready" ? "ready" : "saved", progress: 100, error: undefined, dropboxUploadedPath: uploadedPath });
        rememberSavedFingerprints(brand, [hash]);
        count++;
      }
      setUploadedDropboxPath(null);
      // Reset the intake only after every attempted asset reached Ready.
      // Raw saves remain staged for future edits; partial failures remain recoverable.
      if (mode === "ready" && count === unsaved.length) {
        setFiles([]);
        stagedHashes.current.clear();
        setCollection("");
        setCampaign("");
        setTopic("");
        setCreativeFamily("");
        setEligibilityMode("evergreen");
        setWindowStart("");
        setWindowEnd("");
        setRepeatAnnually(false);
        setSendToApprovalQueue(false);
        setPriority("normal");
        setCreatorNote("");
        setSelectedNetworks(networks);
        setDropboxTestResult("");
      }
      setMessage(count + " asset" + (count===1?"":"s") + (mode==="ready"?" uploaded to Dropbox and registered Ready.":" uploaded to Dropbox and saved Raw.") + " No S3 transfer.");
      setMessageTone("success");
    } catch(error) {
      setMessage((count ? count + " completed. " : "") + (error instanceof Error ? error.message : "Direct Dropbox intake failed") + " No S3 fallback.");
      setMessageTone("error");
    } finally { setBusy(false); }
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

      <DropboxFolderBrowser brand={brand} fileTypes={files.map(file => file.type)} onSelect={setPlannedDropboxFolder} />

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
            <select value={brand} onChange={(e) => {setBrand(e.target.value);setPlannedDropboxFolder(null);}}>
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
        {plannedDropboxFolder && <p style={{padding:12,background:"var(--panel-soft)",borderRadius:8,fontSize:13,overflowWrap:"anywhere"}}><strong>Planned Dropbox folder:</strong> {plannedDropboxFolder}. The buttons below use direct Dropbox for supported images; videos and large files are blocked until upload sessions are available.</p>}
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

        <div style={{marginTop:18,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)"}}>
          <strong>DEV test: Upload one image directly to Dropbox (no S3)</strong>
          <p className="muted" style={{margin:"6px 0 10px"}}>Choose exactly one small image (up to 10 MB) and select a Dropbox folder above. This is a storage-only test: it does not create a Brand OS asset record or make the file ready to publish. Use a disposable image with a unique filename to avoid duplicate-name conflicts.</p>
          <button type="button" disabled={busy||dropboxTestBusy||!plannedDropboxFolder||files.length!==1||!files[0]?.type.startsWith("image/")||files[0]?.size>10*1024*1024} onClick={()=>void testDirectDropboxUpload()} style={buttonPrimary}>{dropboxTestBusy?"Testing…":"Test direct Dropbox upload"}</button>
          {uploadedDropboxPath&&<button type="button" disabled={registeringDropbox||dropboxTestBusy} onClick={()=>void testDropboxRegistration()} style={{...buttonSecondary,marginLeft:8}}>{registeringDropbox?"Registering…":"Register uploaded image as Ready in Brand OS"}</button>}
          {dropboxTestResult&&<p aria-live="polite" style={{margin:"10px 0 0",fontSize:13,overflowWrap:"anywhere"}}>{dropboxTestResult}</p>}
        </div>
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
                ? "Uploading to Dropbox and registering in Brand OS…"
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
