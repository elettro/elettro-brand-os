"use client";

import { useEffect, useState } from "react";

const AUTH_HOST = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_HOST = "https://api.dropboxapi.com/oauth2/token";
const CONTENT_HOST = "https://content.dropboxapi.com/2/files/upload_session";
const CHUNK = 8 * 1024 * 1024;
const STORAGE_PREFIX = "elettro-fast-dropbox-";
const DEFAULT_FOLDER = "/1---elettro-brand-os/stashbox/video/";

function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, value => String.fromCharCode(value)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected upload error";
}

async function postDropbox(token: string, action: "start" | "append_v2" | "finish", args: unknown, body: Blob): Promise<Record<string, unknown>> {
  const response = await fetch(`${CONTENT_HOST}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify(args),
      "Content-Type": "application/octet-stream"
    },
    body
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Dropbox ${action} HTTP ${response.status}: ${text.slice(0, 350)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

export default function FastUploadExperiment() {
  const [appKey, setAppKey] = useState("");
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Experimental direct-to-Dropbox uploader. Existing Add Assets page is unchanged.");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const savedKey = sessionStorage.getItem(STORAGE_PREFIX + "key") || "";
    setAppKey(savedKey);
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    if (!code) return;
    const verifier = sessionStorage.getItem(STORAGE_PREFIX + "verifier");
    const expectedState = sessionStorage.getItem(STORAGE_PREFIX + "state");
    if (!savedKey || !verifier || !expectedState || returnedState !== expectedState) {
      setStatus("Dropbox OAuth state validation failed. Please connect again.");
      return;
    }
    const redirect = window.location.origin + window.location.pathname;
    const form = new URLSearchParams({
      code, grant_type: "authorization_code", client_id: savedKey,
      code_verifier: verifier, redirect_uri: redirect
    });
    fetch(TOKEN_HOST, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })
      .then(async response => {
        const data = await response.json();
        if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "Dropbox authorization failed");
        setToken(data.access_token);
        setStatus("Dropbox connected for this tab. Select a file and destination folder.");
      })
      .catch(error => setStatus(errorText(error)))
      .finally(() => {
        sessionStorage.removeItem(STORAGE_PREFIX + "verifier");
        sessionStorage.removeItem(STORAGE_PREFIX + "state");
        window.history.replaceState(null, "", window.location.pathname);
      });
  }, []);

  async function connect() {
    if (!/^[a-zA-Z0-9]{5,40}$/.test(appKey.trim())) {
      setStatus("Enter your existing Dropbox app key (not its secret).");
      return;
    }
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64Url(new Uint8Array(digest));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    sessionStorage.setItem(STORAGE_PREFIX + "key", appKey.trim());
    sessionStorage.setItem(STORAGE_PREFIX + "verifier", verifier);
    sessionStorage.setItem(STORAGE_PREFIX + "state", state);
    const redirect = window.location.origin + window.location.pathname;
    const params = new URLSearchParams({
      client_id: appKey.trim(), redirect_uri: redirect, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256",
      token_access_type: "online", scope: "files.content.write", state
    });
    window.location.assign(`${AUTH_HOST}?${params}`);
  }

  async function upload() {
    if (!token || !file || busy) return;
    const cleanFolder = folder.replace(/\/+$/, "");
    if (!cleanFolder.startsWith("/1---elettro-brand-os/stashbox/") ||
        cleanFolder.includes("..") || file.name.includes("/")) {
      setStatus("Choose a valid Stashbox Dropbox folder.");
      return;
    }
    const destination = cleanFolder + "/" + file.name;
    setBusy(true); setProgress(0); setSpeed(0);
    const startTime = performance.now();
    let transferred = 0;
    try {
      setStatus("Starting Dropbox upload session…");
      const started = await postDropbox(token, "start", { close: false }, new Blob([]));
      const sessionId = String(started.session_id || "");
      if (!sessionId) throw new Error("Dropbox did not return an upload session ID");
      while (transferred < file.size) {
        const end = Math.min(transferred + CHUNK, file.size);
        await postDropbox(token, "append_v2", {
          cursor: { session_id: sessionId, offset: transferred }, close: end === file.size
        }, file.slice(transferred, end));
        transferred = end;
        const mbps = (transferred / 1048576) / Math.max((performance.now() - startTime) / 1000, 0.001);
        setSpeed(mbps); setProgress(Math.round((transferred / file.size) * 100));
        const remaining = Math.ceil((file.size - transferred) / 1048576 / Math.max(mbps, 0.001));
        setStatus(`Sending directly to Dropbox: ${mbps.toFixed(2)} MB/s, ~${remaining}s remaining`);
      }
      const finished = await postDropbox(token, "finish", {
        cursor: { session_id: sessionId, offset: transferred },
        commit: { path: destination, mode: "add", autorename: false }
      }, new Blob([]));
      const uploadedPath = String(finished.path_display || destination);
      setStatus("Dropbox transfer complete. Registering asset in Brand OS…");
      const response = await fetch("/api/assets/bulk-update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete-dropbox-upload", brandSlug: "stashbox",
          path: uploadedPath, mode: "ready",
          metadata: { sendToApprovalQueue: false, allowedDestinations: [] }
        })
      });
      const result = await response.json();
      if (!response.ok || result.ok === false || !result.asset?.id) {
        throw new Error("Uploaded to Dropbox at " + uploadedPath + ", but Brand OS registration failed: " + (result.error || result.detail || "Unknown error") + ". Do not upload this file again.");
      }
      setStatus(`Success: saved to ${uploadedPath}, registered Ready in Brand OS. Average ${((file.size / 1048576) / Math.max((performance.now() - startTime) / 1000, 0.001)).toFixed(2)} MB/s.`);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 860, margin: "40px auto", padding: 24, fontFamily: "Arial, sans-serif" }}>
      <h1>Fast Upload V2 — Development Test</h1>
      <p>This experimental page uses Dropbox PKCE and transfers bytes directly from your browser to Dropbox. The existing Add Assets uploader remains unchanged. Use only with your trusted Dropbox account.</p>
      <p><strong>Step 1:</strong> Enter the existing Dropbox app key (public client identifier, NOT the app secret). The Dropbox app must permit redirect URI <code>{typeof window !== "undefined" ? window.location.origin + "/assets/fast-upload" : "/assets/fast-upload"}</code>.</p>
      <input aria-label="Dropbox app key" value={appKey} onChange={e => setAppKey(e.target.value)} placeholder="Dropbox app key (not secret)" style={{ width: "100%", padding: 10, marginBottom: 8 }} />
      <button onClick={connect} disabled={busy}>Connect Dropbox securely (PKCE)</button>
      <p><strong>Connection:</strong> {token ? "Connected for this tab" : "Not connected"}</p>
      <p><strong>Step 2:</strong> Select one video and its existing Dropbox folder. The file name must not already exist there.</p>
      <input aria-label="Target Dropbox folder" value={folder} onChange={e => setFolder(e.target.value)} style={{ width: "100%", padding: 10, marginBottom: 8 }} />
      <input type="file" accept="video/*" onChange={e => setFile(e.target.files?.[0] || null)} />
      <p><button onClick={upload} disabled={!token || !file || busy}>{busy ? "Uploading…" : "Upload directly to Dropbox and register Ready"}</button></p>
      <progress value={progress} max={100} style={{ width: "100%" }} />
      <p>{progress}% · {speed.toFixed(2)} MB/s</p>
      <p role="status">{status}</p>
      <p><a href="/assets/add">Return to existing Add Assets (working uploader)</a></p>
    </main>
  );
}
