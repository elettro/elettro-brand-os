import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Dropbox content upload sessions. Binary chunks remain on the server side of
// the Dropbox credential boundary; the browser never receives OAuth tokens.
// Keep chunks <= 2 MiB to fit API Gateway/Lambda JSON payload limits.
const secrets = new SecretsManagerClient({});
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const ROOTS = {
  stashbox: "/1---elettro-brand-os/brands/stashbox",
  solarmeister: "/1---elettro-brand-os/brands/solarmeister",
  weightlossdavie: "/1---elettro-brand-os/brands/weightlossdavie",
  "neckermann-strom": "/1---elettro-brand-os/brands/neckermann-strom",
  therasbox: "/1---elettro-brand-os/brands/therasbox",
  pianomusicsoothing: "/1---elettro-brand-os/brands/pianomusicsoothing",
  elettro: "/1---elettro-brand-os/brands/elettro"
};
const reply = (statusCode, value) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

export async function dropboxAccessToken() {
  const secret = await secrets.send(new GetSecretValueCommand({
    SecretId: process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox"
  }));
  const config = JSON.parse(secret.SecretString || "{}");
  const accessToken = config.access_token || config.accessToken;
  if (accessToken) return accessToken;
  const refreshToken = config.refresh_token || config.refreshToken;
  const appKey = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!appKey || !appSecret || !refreshToken) throw new Error("Dropbox OAuth credentials are not configured");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret });
  const result = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body });
  if (!result.ok) throw new Error("Dropbox token refresh failed: " + result.status);
  return (await result.json()).access_token;
}
function destination(body) {
  const brand = String(body.brand || "");
  const root = ROOTS[brand];
  const directory = String(body.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const filename = String(body.filename || "");
  if (!root || !(directory.toLowerCase() === root.toLowerCase() || directory.toLowerCase().startsWith(root.toLowerCase() + "/"))) throw new Error("Destination outside brand root");
  if (!filename || filename.length > 180 || filename === "." || filename === ".." || /[\/\\\x00-\x1f]/.test(filename)) throw new Error("Invalid filename");
  if (directory.includes("..") || /[\x00-\x1f]/.test(directory)) throw new Error("Invalid destination");
  return directory + "/" + filename;
}
async function contentCall(endpoint, accessToken, arg, bytes) {
  const response = await fetch("https://content.dropboxapi.com/2/files/upload_session/" + endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/octet-stream", "dropbox-api-arg": JSON.stringify(arg) },
    body: bytes
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Dropbox " + endpoint + " failed (" + response.status + "): " + detail.slice(0, 400));
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
export async function handleDropboxUploadSession(body) {
  try {
    const action = String(body.action || "");
    if (!["start-dropbox-upload-session", "append-dropbox-upload-session", "finish-dropbox-upload-session"].includes(action)) return reply(400, { ok: false, error: "Invalid session action" });
    const path = destination(body);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) return reply(400, { ok: false, error: "Invalid file size" });
    const offset = Number(body.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return reply(400, { ok: false, error: "Invalid offset" });
    const encoded = String(body.chunkBase64 || "");
    if (!encoded || encoded.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reply(400, { ok: false, error: "Invalid chunk" });
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.length + offset > size) return reply(400, { ok: false, error: "Chunk exceeds transfer bounds" });
    const isFinal = offset + bytes.length === size;
    if ((action === "finish-dropbox-upload-session") !== isFinal && action !== "start-dropbox-upload-session") return reply(400, { ok: false, error: "Incorrect final chunk action" });
    if (action === "start-dropbox-upload-session" && (offset !== 0 || isFinal)) return reply(400, { ok: false, error: "Start requires a non-final first chunk" });
    const accessToken = await dropboxAccessToken();
    if (action === "start-dropbox-upload-session") {
      // Even for one-chunk files the caller can use an upload session.
      const started = await contentCall("start", accessToken, { close: false }, bytes);
      return reply(200, { ok: true, sessionId: started.session_id, offset: bytes.length, path });
    }
    const sessionId = String(body.sessionId || "");
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(sessionId)) return reply(400, { ok: false, error: "Invalid upload session ID" });
    const cursor = { session_id: sessionId, offset };
    if (!isFinal) {
      await contentCall("append_v2", accessToken, { cursor, close: false }, bytes);
      return reply(200, { ok: true, sessionId, offset: offset + bytes.length, path });
    }
    const metadata = await contentCall("finish", accessToken, { cursor, commit: { path, mode: "add", autorename: false, mute: false, strict_conflict: true } }, bytes);
    return reply(200, { ok: true, complete: true, path: metadata.path_display || path, dropboxFileId: metadata.id, offset: size });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Dropbox session failure";
    return reply(502, { ok: false, error: message });
  }
}
