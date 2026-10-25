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

const networks = ["Instagram", "Facebook", "TikTok", "YouTube", "Threads", "X", "LinkedIn", "Pinterest", "GMB", "Feed"];
const brandChoices = [{id:"stashbox",label:"Stashbox"},{id:"solarmeister",label:"SolarMeister"},{id:"weightlossdavie",label:"WeightLossDavie"},{id:"neckermann-strom",label:"Neckermann Strom"},{id:"therasbox",label:"Therasbox"},{id:"elettro",label:"Elettro"},{id:"pianomusicsoothing",label:"Piano Music Soothing"}];

export function IntakeClient() {
  const [files, setFiles] = useState<IntakeFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const stagedHashes = useRef(new Set<string>());
  const [brand, setBrand] = useState("stashbox");
  const [plannedDropboxFolder, setPlannedDropboxFolder] = useState<string | null>(null);
  const [intakeLibrary, setIntakeLibrary] = useState<"brand"|"stock">("brand");
  const [collection, setCollection] = useState("");
  const [campaign, setCampaign] = useState("");
  const [topic, setTopic] = useState("");
  const [creativeFamily, setCreativeFamily] = useState("");
  const [genre, setGenre] = useState("");
  const [sessionDateDigits, setSessionDateDigits] = useState("");
  const [sessionType, setSessionType] = useState("");
  const [eligibilityMode, setEligibilityMode] = useState<"evergreen" | "window">("evergreen");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [repeatAnnually, setRepeatAnnually] = useState(false);
  const [sendToApprovalQueue, setSendToApprovalQueue] = useState(false);
  const [priority, setPriority] = useState("normal");
  const [creatorNote, setCreatorNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [selectedNetworks, setSelectedNetworks] = useState(networks);
  const [stockAllowedBrands, setStockAllowedBrands] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dropboxTestBusy, setDropboxTestBusy] = useState(false);
  const [dropboxTestResult, setDropboxTestResult] = useState("");
  const [uploadedDropboxPath, setUploadedDropboxPath] = useState<string | null>(null);
  const [registeringDropbox, setRegisteringDropbox] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"idle" | "success" | "error">("idle");
  const [batchReport, setBatchReport] = useState<{total:number;uploaded:number;reused:number;skipped:number;failed:number;registered:number;complete:boolean}|null>(null);
  const [folderInventory, setFolderInventory] = useState<Array<{ path: string; count: number }>>([]);

  const stockAsset = intakeLibrary==="stock" && !!plannedDropboxFolder && /\/creative-assets\/(stock-graphics|stock-videos)(?:\/|$)/i.test(plannedDropboxFolder);
  const stockType = stockAsset ? (/\/stock-videos(?:\/|$)/i.test(plannedDropboxFolder!) ? "stock_video" : "stock_graphic") : null;
  const stockMetadata = stockAsset ? {assetRole:"generative_source",stockType,allowedBrandSlugs:stockAllowedBrands} : {};
  const parsedSessionDate = (() => {
    if (!sessionDateDigits) return null;
    if (sessionDateDigits.length !== 6) return "";
    const yyyy = 2000 + Number(sessionDateDigits.slice(0, 2));
    const mm = Number(sessionDateDigits.slice(2, 4));
    const dd = Number(sessionDateDigits.slice(4, 6));
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return "";
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  })();
  const sessionDateInvalid = sessionDateDigits.length > 0 && !parsedSessionDate;
  const sessionMetadata = brand === "stashbox" ? {
    ...(genre.trim() ? { genre: genre.trim() } : {}),
    ...(parsedSessionDate ? { sessionDate: parsedSessionDate } : {}),
    ...(sessionType ? { sessionType } : {})
  } : {};

  const addTags = (raw: string) => {
    const candidates = raw.split(",").map(value => value.trim()).filter(Boolean);
    setTags(current => {
      const next = [...current];
      for (const candidate of candidates) {
        if (next.some(tag => tag.toLowerCase() === candidate.toLowerCase())) continue;
        if ([...next, candidate].join(", ").length > 500) break;
        next.push(candidate);
      }
      return next;
    });
    setTagInput("");
  };
  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTags(tagInput);
    } else if (event.key === "Backspace" && !tagInput && tags.length) {
      event.preventDefault();
      setTags(current => current.slice(0, -1));
    }
  };

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

  // Dropbox content hash: SHA-256 of concatenated SHA-256 digests of 4 MiB blocks.
  // This is intentionally distinct from a whole-file SHA-256.
  async function dropboxContentHash(file: File): Promise<string> {
    const blockSize = 4 * 1024 * 1024;
    const digests: Uint8Array[] = [];
    for (let offset = 0; offset < file.size; offset += blockSize) {
      digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.slice(offset, offset + blockSize).arrayBuffer())));
    }
    const combined = new Uint8Array(digests.length * 32);
    digests.forEach((digest, index) => combined.set(digest, index * 32));
    const finalHash = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
    return Array.from(finalHash, byte => byte.toString(16).padStart(2, "0")).join("");
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
    if (stockAsset) {setDropboxTestResult("Stock source assets must use Save Raw until the publishing exclusion is verified.");return;}
    setRegisteringDropbox(true);
    try {
      const response = await fetch("/api/assets/bulk-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete-dropbox-upload", brandSlug: brand, path: uploadedDropboxPath, mode: "ready", metadata: {
          collection, campaign, topic, creativeFamily, ...sessionMetadata, eligibilityMode, windowStart, windowEnd,
          repeatAnnually, sendToApprovalQueue, priority, creatorNote, tags, ...stockMetadata, allowedDestinations: stockAsset ? [] : selectedNetworks
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

  // Fast Upload V2: reuse the short-lived PKCE token from the isolated development test.
  // No refresh token or Dropbox app secret is ever persisted in browser storage.
  async function uploadDirectToDropbox(item: IntakeFile, initialToken: string): Promise<string> {
    let accessToken = initialToken;
    if (!plannedDropboxFolder || !plannedDropboxFolder.startsWith("/1---elettro-brand-os/brands/" + brand + "/")) {
      throw new Error("Select a valid Dropbox folder before uploading");
    }
    const folder = plannedDropboxFolder.replace(new RegExp("/+$"), "");
    const path = folder + "/" + item.name;
    const chunkSize = 8 * 1024 * 1024;
    const startedAt = performance.now();
    const send = async (method: "start" | "append_v2" | "finish", args: unknown, blob: Blob) => {
      const uploadChunk = (token: string) => fetch("https://content.dropboxapi.com/2/files/upload_session/" + method, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Dropbox-API-Arg": JSON.stringify(args),
          "Content-Type": "application/octet-stream"
        },
        body: blob
      });
      let response = await uploadChunk(accessToken);
      if (response.status === 401) {
        // An unauthorized chunk was not accepted by Dropbox. Renew and retry once.
        const renewal = await fetch("/api/dropbox/fast-token", {method:"POST"});
        if (!renewal.ok) throw new Error("Fast Dropbox token renewal failed. HTTP 401.");
        const fresh = await renewal.json() as {accessToken?:string};
        if (!fresh.accessToken) throw new Error("Fast Dropbox token renewal failed. HTTP 401.");
        accessToken = fresh.accessToken;
        response = await uploadChunk(accessToken);
      }
      // Retry explicit throttling/service errors only. A network error may
      // mean Dropbox accepted the chunk; blindly repeating could corrupt offsets.
      for(let retry=0;retry<3 && (response.status===429||response.status===503);retry++){
        const wait=Math.min(6000,750*Math.pow(2,retry));
        setMessage("Dropbox temporarily busy. Retrying " + item.name + " ("+(retry+1)+"/3)…");
        await new Promise(resolve=>setTimeout(resolve,wait));
        response=await uploadChunk(accessToken);
      }
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error("Dropbox direct " + method + " HTTP " + response.status + ": " + responseText.slice(0, 280));
      }
      return responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
    };
    const started = await send("start", { close: false }, new Blob([]));
    const sessionId = String(started.session_id || "");
    if (!sessionId) throw new Error("Dropbox did not provide an upload session ID");
    let offset = 0;
    while (offset < item.size) {
      const end = Math.min(item.size, offset + chunkSize);
      await send("append_v2", { cursor: { session_id: sessionId, offset }, close: end === item.size }, item.file.slice(offset, end));
      offset = end;
      const elapsed = Math.max((performance.now() - startedAt) / 1000, 0.001);
      const mbPerSecond = (offset / 1048576) / elapsed;
      const remainingSeconds = Math.ceil((item.size - offset) / 1048576 / Math.max(mbPerSecond, 0.001));
      updateFile(item.id, { status: "uploading", progress: Math.round(offset / item.size * 100) });
      setMessage("Fast Upload: " + item.name + " — " + Math.round(offset / item.size * 100) + "% · " + mbPerSecond.toFixed(2) + " MB/s · ~" + remainingSeconds + " sec remaining");
    }
    const result = await send("finish", {
      cursor: { session_id: sessionId, offset },
      commit: { path, mode: "add", autorename: false }
    }, new Blob([]));
    return String(result.path_display || path);
  }

  // 2 MiB binary chunks are base64 encoded for the API Gateway -> Lambda transport.
  // OAuth credentials stay on AWS; the browser never uploads video through S3.
  async function uploadLargeDropboxFile(item: IntakeFile): Promise<string> {
    const CHUNK = 2 * 1024 * 1024;
    let sessionId = "";
    let offset = 0;
    let uploadedPath = "";
    const uploadStartedAt = performance.now();
    while (offset < item.size) {
      const slice = item.file.slice(offset, Math.min(offset + CHUNK, item.size));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 32768) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      }
      const chunkBase64 = btoa(binary);
      const action = offset === 0 ? "start-dropbox-upload-session" :
        offset + bytes.length === item.size ? "finish-dropbox-upload-session" : "append-dropbox-upload-session";
      const response = await fetch("/api/assets/bulk-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, brand, path: plannedDropboxFolder, filename: item.name,
          size: item.size, sessionId, offset, chunkBase64 })
      });
      const responseText = await response.text();
      let result: { ok?: boolean; error?: string; detail?: string; sessionId?: string; complete?: boolean; path?: string; offset?: number };
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(`Dropbox chunk request returned HTTP ${response.status} ${response.statusText || ""} with ${responseText ? "non-JSON response: " + responseText.slice(0, 160) : "an empty response"}`);
      }
      if (!response.ok || result.ok === false || !result.sessionId && !result.complete) {
        throw new Error(result.error || result.detail || "Dropbox chunk upload failed");
      }
      sessionId = String(result.sessionId || sessionId);
      uploadedPath = String(result.path || uploadedPath);
      offset = Number(result.offset);
      updateFile(item.id, { status: "uploading", progress: Math.round((offset / item.size) * 100) });
      const elapsedSeconds = Math.max((performance.now() - uploadStartedAt) / 1000, 0.001);
      const mbPerSecond = (offset / (1024 * 1024)) / elapsedSeconds;
      const remainingSeconds = mbPerSecond > 0 ? Math.ceil(((item.size - offset) / (1024 * 1024)) / mbPerSecond) : 0;
      const etaLabel = remainingSeconds >= 60 ? `${Math.ceil(remainingSeconds / 60)} min` : `${remainingSeconds} sec`;
      setMessage(`Uploading ${item.name} to Dropbox — ${Math.round((offset / item.size) * 100)}% · ${mbPerSecond.toFixed(2)} MB/s · ~${etaLabel} remaining`);
    }
    if (offset !== item.size || !uploadedPath) throw new Error("Dropbox upload did not complete");
    return uploadedPath;
  }

  // DEV direct Dropbox intake. Unsupported large uploads STOP; there is no S3 fallback.
  async function submitBatch(mode: "raw" | "ready") {
    if (busy || dropboxTestBusy || registeringDropbox || files.length === 0) return;
    if (intakeLibrary==="stock") {setMessage("Shared Stock uploading is not enabled until the backend supports safe global-root registration and brand permissions.");setMessageTone("error");return;}
    if (!plannedDropboxFolder) {
      setMessage("Select a Dropbox destination folder before saving.");
      setMessageTone("error");
      return;
    }
    if (stockAsset && stockAllowedBrands.length === 0) {
      setMessage("Choose at least one brand permitted to use this stock asset.");
      setMessageTone("error");return;
    }
    if (stockAsset && mode === "ready") {
      setMessage("Stock source assets must use Save Raw until the publishing exclusion is verified.");
      setMessageTone("error");return;
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
    const unsupported = unsaved.find(item => !item.type.startsWith("image/") && !item.type.startsWith("video/"));
    if (unsupported) {
      setMessage("Only image and video files are supported by Dropbox direct intake.");
      setMessageTone("error");
      return;
    }
    if (sessionDateInvalid) {
      setMessage("Session Date must be six valid digits (YYMMDD), or leave it blank.");
      setMessageTone("error");
      return;
    }
    setBusy(true);
    setBatchReport(null);
    setMessageTone("idle");
    setMessage("Beginning direct Dropbox intake, without S3…");
    let count = 0;
    let enriched = 0;
    let enrichFailed = 0;
    const report = {total:unsaved.length,uploaded:0,reused:0,skipped:0,failed:0,registered:0,complete:false};
    let currentFile: IntakeFile | null = null;
    const publishReport = () => setBatchReport({...report});
    try {
      setMessage("Fingerprinting " + unsaved.length + " files and checking the full " + brand + " Dropbox library…");
      const fileFingerprints = await Promise.all(unsaved.map(async item=>({
        name:item.name,size:item.size,contentHash:await dropboxContentHash(item.file)
      })));
      const preflightResponse = await fetch("/api/dropbox/preflight", {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({brand,folder:plannedDropboxFolder,names:unsaved.map(item=>item.name),files:fileFingerprints})
      });
      const preflight = await preflightResponse.json() as {
        results?:Array<{name:string;exists:boolean;size?:number;contentHash?:string;path?:string}>;
        matches?:Array<{name:string;path:string;id:string}|null>;error?:string
      };
      if(!preflightResponse.ok || !preflight.results || preflight.results.length!==unsaved.length || !preflight.matches || preflight.matches.length!==unsaved.length)
        throw Error(preflight.error || "Dropbox pre-upload check failed. No transfers started.");
      const seen = new Set<string>();
      for (const [index,item] of unsaved.entries()) {
        currentFile = item;
        const hash = item.sha256 || await sha256(item.file);
        if (seen.has(hash)) { report.skipped++; publishReport(); currentFile=null; continue; }
        seen.add(hash);
        let uploadedPath = item.dropboxUploadedPath || (files.length === 1 ? uploadedDropboxPath : null);
        const existing = preflight.results[index];
        const brandMatch = preflight.matches[index];
        if (!uploadedPath && brandMatch && !existing.exists) {
          uploadedPath = brandMatch.path;
          report.reused++;
          updateFile(item.id,{status:"uploaded",progress:100,dropboxUploadedPath:uploadedPath});
          setMessage("Exact duplicate found elsewhere in " + brand + ": " + brandMatch.path + ". Registering without uploading…");
        }
        if (!uploadedPath && existing.exists) {
          // Same path does not necessarily mean identical content. Compare
          // Dropbox's exact content hash before reusing the existing file.
          if (existing.size !== item.size || !existing.contentHash) {
            updateFile(item.id,{status:"error",error:"Filename already exists in Dropbox, but size or hash is unavailable. Skipped safely."});
            report.failed++; publishReport(); currentFile=null; continue;
          }
          setMessage("Checking content match for existing " + item.name + "…");
          const localHash = fileFingerprints[index].contentHash;
          if(localHash !== existing.contentHash.toLowerCase()) {
            updateFile(item.id,{status:"error",error:"Different file already uses this Dropbox filename. No overwrite or duplicate upload attempted."});
            report.failed++; publishReport(); currentFile=null; continue;
          }
          report.reused++;
          uploadedPath = existing.path || plannedDropboxFolder.replace(new RegExp("/+$"), "") + "/" + item.name;
          updateFile(item.id,{status:"uploaded",progress:100,dropboxUploadedPath:uploadedPath});
          setMessage("Exact Dropbox duplicate verified. Registering without uploading " + item.name + "…");
        }
        if (!uploadedPath) {
          if (getSavedFingerprints(brand).has(hash)) {
            updateFile(item.id, { status: "error", error: "Previously saved in this browser; skipped to avoid a duplicate." });
            report.skipped++; publishReport(); currentFile=null; continue;
          }
          updateFile(item.id, { status: "uploading", error: undefined, progress: 0 });
          setMessage("Uploading " + item.name + " directly to Dropbox…");
          if (item.size > 10 * 1024 * 1024) {
            // Prefer the verified browser-to-Dropbox path when this tab has a PKCE session.
            // Without it, use the existing working AWS uploader unchanged.
            let fastToken: string | null = null;
            try {
              const authorization = await fetch("/api/dropbox/fast-token", { method: "POST" });
              if (authorization.ok) {
                const result = await authorization.json() as {accessToken?:string};
                fastToken = result.accessToken || null;
              }
            } catch { /* Existing secure AWS uploader remains the fallback. */ }
            if (fastToken) {
              try {
                uploadedPath = await uploadDirectToDropbox(item, fastToken);
              } catch (directError) {
                // A 401 means the short-lived browser session expired. Its upload
                // session was not committed; retry this file via the safe AWS relay.
                if (!(directError instanceof Error) || !directError.message.includes("HTTP 401")) throw directError;
                setMessage("Dropbox fast session expired. Continuing automatically with secure AWS upload for " + item.name + "…");
                uploadedPath = await uploadLargeDropboxFile(item);
              }
            } else {
              uploadedPath = await uploadLargeDropboxFile(item);
            }
          } else {
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
          }
          report.uploaded++;
          updateFile(item.id, { status: "uploaded", progress: 100, dropboxUploadedPath: uploadedPath });
        }
        setMessage("Verifying and registering " + item.name + " in Brand OS…");
        const registerPayload = JSON.stringify({ action: "complete-dropbox-upload", brandSlug: brand, path: uploadedPath, mode,
          metadata: { collection, campaign, topic, creativeFamily, ...sessionMetadata, eligibilityMode, windowStart, windowEnd,
            repeatAnnually, sendToApprovalQueue, priority, creatorNote, tags, ...stockMetadata, allowedDestinations: stockAsset ? [] : selectedNetworks } });
        let response: Response | undefined;
        for (let attempt=0;attempt<3;attempt++) {
          try {
            response = await fetch("/api/assets/bulk-update",{
              method:"POST",headers:{"content-type":"application/json"},body:registerPayload
            });
            if(response.ok || (response.status!==429 && response.status<500)) break;
          }catch { /* Server may have registered it; server must enforce idempotency by Dropbox file ID. */ }
          if(attempt<2) {
            setMessage("Verifying registration for "+item.name+" (retry "+(attempt+2)+"/3)…");
            await new Promise(resolve=>setTimeout(resolve,750*Math.pow(2,attempt)));
          }
        }
        if(!response)throw Error("Dropbox has "+item.name+", but registration was interrupted. Retry Ingest & Ready; file will not be reuploaded.");
        const result = await response.json();
        if (!response.ok || result.ok === false || !result.asset?.id) {
          throw new Error("Dropbox has " + item.name + ", but registration failed: " + (result.detail || result.error || "Unknown error") + ". Retry without uploading again.");
        }
        updateFile(item.id, { status: mode === "ready" ? "ready" : "saved", progress: 100, error: undefined, dropboxUploadedPath: uploadedPath });
        rememberSavedFingerprints(brand, [hash]);
        count++;
        report.registered++;
        // DEV opt-in: registration must succeed even if AI vision is unavailable.
        // A one-frame video preview is an aid, not a full-video inspection.
        if (process.env.NEXT_PUBLIC_EPE_AUTO_ENRICH_ENABLED === "true" && !stockAsset) {
          try {
            setMessage("Analyzing " + item.name + " for missing metadata…");
            const aiResponse = await fetch("/api/assets/auto-enrich", {
              method: "POST", headers: {"content-type":"application/json"},
              body: JSON.stringify({ brandSlug: brand, assetId: result.asset.id })
            });
            const aiResult = await aiResponse.json();
            if (aiResponse.ok && aiResult.ok === true) {
              if (Array.isArray(aiResult.updatedFields) && aiResult.updatedFields.length) enriched++;
            } else enrichFailed++;
          } catch { enrichFailed++; }
        }
        currentFile=null;
        publishReport();
      }
      report.complete=true;
      publishReport();
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
        setGenre("");
        setSessionDateDigits("");
        setSessionType("");
        setEligibilityMode("evergreen");
        setWindowStart("");
        setWindowEnd("");
        setRepeatAnnually(false);
        setSendToApprovalQueue(false);
        setPriority("normal");
        setCreatorNote("");
        setTags([]);
        setTagInput("");
        setSelectedNetworks(networks);
        setStockAllowedBrands([]);
        setDropboxTestResult("");
      }
      setMessage(`${report.total} checked · ${report.uploaded} uploaded · ${report.reused} reused from Dropbox · ${report.registered} registered · ${report.skipped} skipped · ${report.failed} conflicts.` +
        (process.env.NEXT_PUBLIC_EPE_AUTO_ENRICH_ENABLED === "true" ? ` AI enriched: ${enriched}; analysis unavailable: ${enrichFailed}.` : "") + " No S3 transfer.");
      setMessageTone(report.failed ? "error" : "success");
    } catch(error) {
      if(currentFile && report.uploaded + report.reused + report.skipped + report.failed < report.total) report.failed++;
      publishReport();
      setMessage((count ? count + " completed. " : "") + (error instanceof Error ? error.message : "Direct Dropbox intake failed") + " No S3 fallback.");
      setMessageTone("error");
    } finally { setBusy(false); }
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      <section
        className="card"
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          addFiles(event.dataTransfer.files);
        }}
        style={{ border: dragActive ? "3px dashed #1477d4" : "3px dashed #98a9bf", background: dragActive ? "rgba(129,236,255,.16)" : "rgba(129,236,255,.06)", padding: 30, textAlign: "center", borderRadius: 14, boxShadow: dragActive ? "0 0 0 6px rgba(20,119,212,.20)" : "none", transition: "background .18s,border-color .18s,box-shadow .18s" }}
      >
        <h2 style={{ marginTop: 0 }}>Drop assets here</h2>
        <p className="muted">
          Drop images or videos here to stage them for saving to your chosen Dropbox destination.
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

      {batchReport && (
        <section className="card" aria-live="polite" style={{padding:16,border:"1px solid var(--line)"}}>
          <h3 style={{marginTop:0}}>Batch {batchReport.complete?"completion":"progress"} report</h3>
          <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
            <strong>{batchReport.total} checked</strong>
            <span>{batchReport.uploaded} new uploads</span>
            <span>{batchReport.reused} existing Dropbox files reused</span>
            <span>{batchReport.registered} registered</span>
            <span>{batchReport.skipped} skipped</span>
            <span>{batchReport.failed} conflicts / failures</span>
          </div>
          {!batchReport.complete && <p className="muted" style={{marginBottom:0}}>Batch incomplete or still processing. Do not assume every queued file was registered.</p>}
        </section>
      )}
      <section className="card" style={{marginTop:14}}>
        <div className="eyebrow">Choose asset library</div>
        <div style={{display:"flex",gap:10,marginTop:10,flexWrap:"wrap"}}>
          <button type="button" aria-pressed={intakeLibrary==="brand"} onClick={()=>{setIntakeLibrary("brand");setPlannedDropboxFolder(null);setStockAllowedBrands([]);}} style={intakeLibrary==="brand"?buttonPrimary:buttonSecondary}>Brand</button>
          <button type="button" aria-pressed={intakeLibrary==="stock"} onClick={()=>{setIntakeLibrary("stock");setPlannedDropboxFolder(null);setStockAllowedBrands([brand]);}} style={intakeLibrary==="stock"?buttonPrimary:buttonSecondary}>Stock</button>
        </div>
        <p className="muted" style={{fontSize:13,marginBottom:0}}>{intakeLibrary==="stock"?"Stock opens the shared Elettro Creative Assets library. Uploading is disabled until shared-root backend handling is verified.":"Brand opens the current brand’s Dropbox library."}</p>
      </section>
      <DropboxFolderBrowser brand={brand} mode={intakeLibrary} fileTypes={files.map(file => file.type)} onSelect={value=>{setPlannedDropboxFolder(value);setStockAllowedBrands(value && /\/creative-assets\/(stock-graphics|stock-videos)(?:\/|$)/i.test(value) ? [brand] : []);}} />

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
            <select value={brand} onChange={(e) => {setBrand(e.target.value);setPlannedDropboxFolder(null);setStockAllowedBrands([]);}}>
              <option value="stashbox">Stashbox</option>
              <option value="solarmeister">SolarMeister</option>
              <option value="weightlossdavie">WeightLossDavie</option>
              <option value="neckermann-strom">Neckermann Strom</option>
              <option value="therasbox">Therasbox</option>
              <option value="elettro">Elettro</option>
              <option value="pianomusicsoothing">Piano Music Soothing</option>
            </select>
          </Field>
          <Field label={brand === "stashbox" ? "Show / Music Series" : "Collection"}>
            <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder={brand === "stashbox" ? "e.g. Stashbox Does Dylan, Originals, Stashbox Radio" : "Optional"} />
          </Field>
          <Field label={brand === "stashbox" ? "Promotion / Initiative" : "Campaign"}>
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label={brand === "stashbox" ? "Content Focus" : "Topic / Product"}>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label={brand === "stashbox" ? "Song / Creative Title" : "Creative Family"}>
            <input value={creativeFamily} onChange={(e) => setCreativeFamily(e.target.value)} placeholder="Optional" />
          </Field>
          {brand === "stashbox" && (
            <Field label="Genre (optional)">
              <input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="e.g. Reggae, Rock, Americana, Funk" />
            </Field>
          )}
          {brand === "stashbox" && (
            <>
              <Field label="Session Date (optional)">
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <input aria-label="Session date six digits" type="text" inputMode="numeric" maxLength={6}
                    value={sessionDateDigits}
                    onChange={event=>setSessionDateDigits(event.target.value.replace(/\\D/g,"").slice(0,6))}
                    placeholder="YYMMDD" style={{width:120}} />
                  <input aria-label="Pick session date from calendar" type="date" value={parsedSessionDate || ""}
                    onChange={event=>{
                      const value = event.target.value;
                      setSessionDateDigits(value ? value.slice(2,4)+value.slice(5,7)+value.slice(8,10) : "");
                    }} style={{width:156}} />
                  {sessionDateDigits && <button type="button" onClick={()=>setSessionDateDigits("")}>Clear</button>}
                </div>
                {sessionDateInvalid && <small style={{color:"#ff9b8f"}}>Enter a real date as YYMMDD, or leave blank.</small>}
              </Field>
              <Field label="Session Type (optional)">
                <select value={sessionType} onChange={event=>setSessionType(event.target.value)}>
                  <option value="">Not tied to a session</option>
                  <option value="studio_recording">Studio Recording</option>
                  <option value="live_show">Live Show</option>
                  <option value="rehearsal">Rehearsal</option>
                  <option value="interview">Interview</option>
                  <option value="behind_the_scenes">Behind the Scenes</option>
                  <option value="brand_promo">Brand Promo</option>
                  <option value="song_promo">Song Promo</option>
                  <option value="other">Other</option>
                </select>
              </Field>
            </>
          )}
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
          <Field label="Tags">
            <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:6,padding:8,border:"1px solid var(--line)",borderRadius:8,minHeight:44,background:"var(--panel)"}}>
              {tags.map(tag => <span key={tag} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 8px",borderRadius:7,background:"var(--panel-soft)",border:"1px solid var(--line)",fontSize:13}}>
                {tag}<button type="button" aria-label={`Remove tag ${tag}`} onClick={()=>setTags(current=>current.filter(item=>item!==tag))} style={{border:0,background:"transparent",cursor:"pointer",fontWeight:800}}>×</button>
              </span>)}
              <input aria-label="Add tags" value={tagInput} onChange={event=>{const value=event.target.value;if(value.includes(","))addTags(value);else setTagInput(value);}} onKeyDown={handleTagKeyDown} onBlur={()=>{if(tagInput.trim())addTags(tagInput);}} placeholder={tags.length?"Add tag":"People, subjects, keywords"} style={{flex:"1 1 140px",minWidth:130,border:0,outline:"none",padding:5}} />
            </div>
            <small className="muted">Enter or comma adds a tag. Applies to all files in this intake batch. {tags.join(", ").length}/500</small>
          </Field>
          <Field label="Creator Note">
            <input value={creatorNote} onChange={(e) => setCreatorNote(e.target.value)} placeholder="e.g. Strong booking clips, favor these" />
          </Field>
        </div>

        {stockAsset && (
          <div className="card" style={{marginTop:18,border:"2px solid var(--line)",background:"var(--panel-soft)"}}>
            <div className="eyebrow">Creative source asset</div>
            <h3 style={{margin:"5px 0 8px"}}>Which brands are allowed to use this stock art?</h3>
            <p className="muted" style={{margin:"0 0 12px"}}>Required for {stockType==="stock_video"?"Stock Videos":"Stock Graphics"}. Choose the brands allowed to reuse these assets.</p>
            <div style={{display:"flex",flexWrap:"wrap",gap:14}}>
              {brandChoices.map(option=>(
                <label key={option.id} style={{display:"inline-flex",alignItems:"center",gap:7,fontSize:14}}>
                  <input type="checkbox" checked={stockAllowedBrands.includes(option.id)}
                    onChange={event=>setStockAllowedBrands(current=>event.target.checked ? [...current,option.id] : current.filter(id=>id!==option.id))}/>
                  {option.label}
                </label>
              ))}
            </div>
            {stockAllowedBrands.length===0 && <p role="alert" style={{color:"#ff9b8f",fontSize:13,marginBottom:0}}>Select at least one brand before saving.</p>}
            <p className="muted" style={{fontSize:12,marginBottom:0}}>Stock sources use Save Raw for now. Brand selections are forwarded as metadata; server-side usage enforcement requires validation.</p>
          </div>
        )}
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
                  {["File", "Quick analysis", "Size", "Status"].map((label) => (
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
                            background: "var(--panel)",
                            color: "#ff9b8f",
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
                    <td style={td}>
                      <span className="status-chip">
                        {file.status === "queued" ? "Queued" :
                         file.status === "analyzing" ? "Analyzing" :
                         file.status === "analyzed" ? "Ready to Save" :
                         file.status === "uploading" ? `Uploading ${file.progress}%` :
                         file.status === "uploaded" ? "Uploaded" :
                         file.status === "saved" ? "Raw · Saved" :
                         file.status === "ready" ? "Ready" : "Error"}
                      </span>
                      {file.error && (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#ff9b8f" }}>{file.error}</div>
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
          <button type="button" disabled={intakeLibrary==="stock"||busy||dropboxTestBusy||!plannedDropboxFolder||files.length!==1||!files[0]?.type.startsWith("image/")||files[0]?.size>10*1024*1024} onClick={()=>void testDirectDropboxUpload()} style={buttonPrimary}>{dropboxTestBusy?"Testing…":"Test direct Dropbox upload"}</button>
          {uploadedDropboxPath&&<button type="button" disabled={registeringDropbox||dropboxTestBusy||stockAsset} onClick={()=>void testDropboxRegistration()} style={{...buttonSecondary,marginLeft:8}}>{registeringDropbox?"Registering…":"Register uploaded image as Ready in Brand OS"}</button>}
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
                  ? "#2efd7c"
                  : messageTone === "error"
                    ? "#ff9b8f"
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
              disabled={!files.length || busy || intakeLibrary==="stock"}
              onClick={() => submitBatch("raw")}
              style={buttonSecondary}
            >
              {busy ? "Uploading…" : "Save Raw"}
            </button>
            <button
              type="button"
              disabled={!files.length || busy || intakeLibrary==="stock" || stockAsset}
              title={stockAsset ? "Stock assets must use Save Raw until server-side publishing exclusion is verified" : undefined}
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
const buttonSecondary = { border: "1px solid var(--line)", borderRadius: 9, padding: "10px 14px", background: "var(--panel)", color: "var(--text)", fontWeight: 700, cursor: "pointer" };
