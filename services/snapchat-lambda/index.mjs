import { createCipheriv, randomBytes } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Snapchat worker for Elettro OS (Snap Public Profile API, https://businessapi.snapchat.com). Runs outside the VPC and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   the tick: renew access tokens (they last 30 minutes), then send approved
//                                             Snapchat posts whose time has come (planner claim-due-posts / finish-post)
//   { action: "refresh" }                     renew tokens only, on demand
//   { action: "profile", brand }              read the connected Public Profile back from Snap (a safe first API check)
//   { action: "post", brand, dropboxPath, kind?, caption? }
//                                             send a Dropbox video as a "story" (default) or a "spotlight"
// How a post goes out (Snap's Public Profile API):
//   1. POST /v1/public_profiles/{id}/media {type, name, key, iv}  ->  media_id, add_path, finalize_path
//   2. the video is encrypted with AES-256-CBC (the key and iv sent in step 1), cut into parts of at most 32 MB and
//      each part is POSTed to add_path as multipart (action=ADD, part_number 1..35)
//   3. POST finalize_path (action=FINALIZE)
//   4. POST /v1/public_profiles/{id}/stories {media_id}   or   /spotlights {media_id, locale, description, skip_save_to_profile}
// Video rules (Snap): .mp4, 5-60 seconds, at least 540x960. A created media object stays usable for 24 hours.
// The API is allowlist-only: until Snap approves our OAuth client id every call answers with an authorization error.
// The field encodings in steps 1-3 come from Snap's reference page and have not been exercised against the live API yet.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
const APP_SECRET = process.env.SNAPCHAT_OAUTH_SECRET_NAME || "elettro-brand-os-dev/snapchat-oauth";
const TOKEN_PREFIX = process.env.SNAPCHAT_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/snapchat/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const API = "https://businessapi.snapchat.com";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
const MB = 1024 * 1024;
export const PART_BYTES = 32 * MB;
export const MAX_PARTS = 35;
export const DESCRIPTION_MAX = 160;
export const MAX_TAGS = 2;
const PLACEMENTS = ["story", "spotlight"];
const POSTS_PER_TICK = 1;
// Access tokens last 30 minutes and the tick runs every 15: renew whenever less than 20 minutes are left.
const RENEW_WITHIN_MS = 20 * 60 * 1000;
const LOCALE = process.env.SNAPCHAT_LOCALE || "en_US";

const result = (statusCode, payload) => ({ statusCode, ...payload });

// ---------- tokens ----------

export function needsRefresh(record, now = new Date(), within = RENEW_WITHIN_MS) {
  const expires = Date.parse(record?.accessExpiresAt || "");
  return !Number.isFinite(expires) || expires - now.getTime() < within;
}

export async function refreshRecord(record, app, now = new Date(), post = fetch) {
  if (!record?.refreshToken) throw new Error("no refresh token stored");
  const response = await post(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: app.clientId, client_secret: app.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`Snapchat refresh failed: ${body.error_description || body.error || response.status}`);
  }
  const seconds = Number(body.expires_in);
  return {
    ...record,
    accessToken: body.access_token,
    accessExpiresAt: new Date(now.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1800) * 1000).toISOString(),
    // A refresh may hand back a new refresh token; keep the old one when it does not.
    refreshToken: body.refresh_token || record.refreshToken,
    refreshedAt: now.toISOString()
  };
}

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

const writeSecret = (SecretId, record) => secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) }));

async function tokenSecretNames() {
  const names = [];
  let NextToken;
  do {
    const page = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }], NextToken }));
    for (const s of page.SecretList || []) if (s.Name?.startsWith(TOKEN_PREFIX)) names.push(s.Name);
    NextToken = page.NextToken;
  } while (NextToken);
  return names;
}

async function appCredentials() {
  const app = await secretJson(APP_SECRET);
  if (!app.clientId || !app.clientSecret) throw new Error(`${APP_SECRET} needs "clientId" and "clientSecret"`);
  return app;
}

export async function refreshAll(now = new Date(), deps = {}) {
  const { app = await appCredentials(), names = await tokenSecretNames(), read = secretJson, write = writeSecret, refresh = refreshRecord } = deps;
  const accounts = [];
  for (const SecretId of names) {
    const record = await read(SecretId);
    const handle = record.handle || record.profileId;
    if (record.revokedAt) continue;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, accessExpiresAt: record.accessExpiresAt }); continue; }
    try {
      const next = await refresh(record, app, now);
      await write(SecretId, next);
      accounts.push({ handle, refreshed: true, accessExpiresAt: next.accessExpiresAt });
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("Snapchat refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("Snapchat refresh", JSON.stringify(summary));
  return summary;
}

// The token record for a brand (manual posts) or a profile id (planner posts), renewed first when it is about to lapse.
export async function account(brand, profileId, deps = {}) {
  const { names = await tokenSecretNames(), read = secretJson, app = appCredentials, write = writeSecret, refresh = refreshRecord } = deps;
  for (const SecretId of profileId ? names.filter((n) => n === TOKEN_PREFIX + profileId.toLowerCase()) : names) {
    let record = await read(SecretId);
    if (record.revokedAt || (!profileId && record.brand !== brand)) continue;
    // Keep 5+ minutes in hand: encrypting and uploading a long video takes a while.
    if (needsRefresh(record, new Date(), 5 * 60 * 1000)) {
      record = await refresh(record, await app());
      await write(SecretId, record);
    }
    return record;
  }
  throw new Error(`No Snapchat profile is connected for ${profileId || brand}`);
}

// ---------- requests ----------

// A Spotlight description: the caption, plus hashtags only while they still fit in 160 characters. A caption that is too
// long on its own is trimmed at the last whole word.
export function spotlightText(caption, hashtags = []) {
  let text = String(caption || "").replace(/\s+/g, " ").trim();
  if (text.length > DESCRIPTION_MAX) text = text.slice(0, DESCRIPTION_MAX - 1).replace(/\s+\S*$/, "") + "…";
  for (const raw of (hashtags || []).slice(0, MAX_TAGS)) {
    const tag = "#" + String(raw).replace(/^#/, "").replace(/\s+/g, "");
    if (tag.length > 1 && (text + " " + tag).trim().length <= DESCRIPTION_MAX && !text.includes(tag)) text = (text + " " + tag).trim();
  }
  return text;
}

export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as stashbox");
  const dropboxPath = String(event.dropboxPath || "").replace(/\\/g, "/");
  if (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  }
  if (!/\.mp4$/i.test(dropboxPath)) throw new Error("Snapchat takes .mp4 video only");
  const kind = event.kind || "story";
  if (!PLACEMENTS.includes(kind)) throw new Error('kind must be "story" or "spotlight"');
  return { brand, dropboxPath, kind, description: kind === "spotlight" ? spotlightText(event.caption, event.hashtags) : "" };
}

// A planner post as a post request. A Story carries no text, so only a Spotlight uses the caption.
export function requestFromPost(post) {
  const kind = post.placement === "spotlight" ? "spotlight" : "story";
  const request = postRequest({ brand: "planner", dropboxPath: post.dropboxPath, kind, caption: post.caption, hashtags: post.hashtags || [] });
  return { ...request, profileId: String(post.channelId || "") };
}

// ---------- Dropbox ----------

async function dropboxAccessToken() {
  const config = await secretJson(DROPBOX_SECRET);
  const refreshToken = config.refresh_token || config.refreshToken;
  const appKey = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!refreshToken || !appKey || !appSecret) throw new Error("Dropbox OAuth refresh configuration is incomplete");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox refresh failed (HTTP ${response.status})`);
  return (await response.json()).access_token;
}

async function dropboxBytes(path) {
  const linkResponse = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST", headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(20000)
  });
  if (!linkResponse.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${linkResponse.status})`);
  const { link, metadata } = await linkResponse.json();
  const file = await fetch(link, { signal: AbortSignal.timeout(240000) });
  if (!file.ok) throw new Error(`Dropbox download failed (HTTP ${file.status})`);
  return { bytes: Buffer.from(await file.arrayBuffer()), name: metadata?.name || path.split("/").pop() };
}

// ---------- encryption + parts ----------

// AES-256-CBC: a 32-byte key and a 16-byte iv, both sent to Snap base64-encoded when the media object is created.
export function encryptVideo(bytes, random = randomBytes) {
  const key = random(32), iv = random(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return { encrypted: Buffer.concat([cipher.update(bytes), cipher.final()]), key: key.toString("base64"), iv: iv.toString("base64") };
}

export function splitParts(buffer, size = PART_BYTES) {
  const parts = [];
  for (let at = 0; at < buffer.length; at += size) parts.push(buffer.subarray(at, Math.min(at + size, buffer.length)));
  if (!parts.length) throw new Error("the video is empty");
  if (parts.length > MAX_PARTS) throw new Error(`the video needs ${parts.length} parts; Snap allows ${MAX_PARTS}`);
  return parts;
}

// ---------- Snap calls ----------

const absolute = (path) => (/^https?:\/\//i.test(path) ? path : `${API}/${String(path).replace(/^\/+/, "")}`);

async function snap(url, accessToken, init = {}, call = fetch) {
  const response = await call(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(120000) });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || (out.request_status && out.request_status !== "SUCCESS")) {
    const why = out.display_message || out.debug_message || out.error_description || out.error || "";
    throw new Error(`Snapchat ${new URL(url).pathname.replace(/[0-9a-f-]{36}/gi, ":id")} failed: HTTP ${response.status}${out.error_code ? " " + out.error_code : ""}${why ? " — " + why : ""}`);
  }
  return out;
}

const jsonBody = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const formBody = (fields, file) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, String(v));
  if (file) data.append("file", new Blob([file.bytes]), file.name);
  return { method: "POST", body: data };
};

// Snap's answers are read leniently: an id may sit at the top level or under the object's own name.
const pick = (out, ...keys) => {
  for (const k of keys) { const v = out?.[k] ?? out?.media?.[k] ?? out?.story?.[k] ?? out?.spotlight?.[k]; if (v) return v; }
  return undefined;
};

export async function profileOf(accessToken, call = fetch) {
  const out = await snap(`${API}/v1/public_profiles/my_profile`, accessToken, {}, call);
  return out.public_profile || {};
}

export async function uploadMedia(profileId, accessToken, video, deps = {}) {
  const { call = fetch, encrypt = encryptVideo } = deps;
  const { encrypted, key, iv } = encrypt(video.bytes);
  const created = await snap(`${API}/v1/public_profiles/${profileId}/media`, accessToken, jsonBody({ type: "VIDEO", name: video.name, key, iv }), call);
  const mediaId = pick(created, "media_id", "id"), addPath = pick(created, "add_path"), finalizePath = pick(created, "finalize_path");
  if (!mediaId || !addPath || !finalizePath) throw new Error("Snapchat did not return a media id and upload paths");
  const parts = splitParts(encrypted);
  for (const [i, bytes] of parts.entries()) {
    await snap(absolute(addPath), accessToken, formBody({ action: "ADD", part_number: i + 1 }, { bytes, name: video.name }), call);
  }
  await snap(absolute(finalizePath), accessToken, formBody({ action: "FINALIZE" }), call);
  return { mediaId, parts: parts.length };
}

// Snap may still be processing the upload when the post is asked for; try a few times before giving up.
export async function publishMedia(profileId, accessToken, mediaId, request, deps = {}) {
  const { call = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 6, delayMs = 5000 } = deps;
  const url = `${API}/v1/public_profiles/${profileId}/${request.kind === "spotlight" ? "spotlights" : "stories"}`;
  const body = request.kind === "spotlight"
    ? { media_id: mediaId, locale: LOCALE, skip_save_to_profile: false, ...(request.description ? { description: request.description } : {}) }
    : { media_id: mediaId };
  let last;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const out = await snap(url, accessToken, jsonBody(body), call);
      return { id: pick(out, "spotlight_id", "story_id", "id") || mediaId, out };
    } catch (error) {
      last = error;
      if (attempt < tries) await wait(delayMs);
    }
  }
  throw last;
}

export async function publish(record, request, deps = {}) {
  const { download = dropboxBytes } = deps;
  const video = await download(request.dropboxPath);
  const { mediaId, parts } = await uploadMedia(record.profileId, record.accessToken, video, deps);
  const posted = await publishMedia(record.profileId, record.accessToken, mediaId, request, deps);
  return { handle: record.handle, kind: request.kind, file: video.name, bytes: video.bytes.length, parts, mediaId, id: posted.id };
}

// ---------- tick + handler ----------

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, find = account, send = publish } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "snapchat", placements: PLACEMENTS, limit: POSTS_PER_TICK, retryStuck: true });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const record = await find(null, request.profileId);
      const sent = await send(record, request);
      outcome = { externalPostId: sent.id };
    } catch (error) {
      console.error("Scheduled Snapchat post failed:", post.id, error?.message);
      outcome = { error: error?.message || "Post failed" };
    }
    await callApi({ action: "finish-post", id: post.id, ...outcome });
    published.push({ id: post.id, ...outcome });
  }
  return { missed: claimed.missed, stuck: claimed.stuck, published };
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick") {
    // Tokens first, so a post never goes out on an expired token; a refresh failure doesn't stop posting.
    const refresh = await refreshAll().catch((error) => ({ ok: false, error: error?.message }));
    try {
      const tick = await publishingTick();
      console.log("Snapchat tick", JSON.stringify(tick));
      return result(200, { ok: refresh.ok !== false, refresh, ...tick });
    } catch (error) {
      console.error("Snapchat tick failed:", error?.message);
      return result(502, { ok: false, refresh, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("Snapchat refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  if (event.action === "profile") {
    try {
      const record = await account(String(event.brand || ""), null);
      const p = await profileOf(record.accessToken);
      return result(200, { ok: true, id: p.id, displayName: p.display_name, username: p.snap_user_name, tier: p.profile_tier, type: p.profile_type });
    } catch (error) { return result(502, { ok: false, error: error?.message || "Profile lookup failed" }); }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const record = await account(request.brand, null);
      const posted = await publish(record, request);
      console.log("Snapchat post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("Snapchat post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
