import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Uploads videos from the brand Dropbox to connected YouTube channels.
// Runs outside the VPC (it needs Google and Dropbox) and is only invoked directly
// through IAM: no HTTP route points at it. Two ways in:
//   { channelId, dropboxPath, title, ... }  upload one video now
//   an EventBridge schedule (every 15 min)  the publishing tick: keep the plan filled,
//                                           then upload approved posts whose time has come

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// Until Google's audit passes, YouTube forces API uploads to private anyway.
const SCHEDULED_PRIVACY = process.env.YOUTUBE_PRIVACY || "private";
const POSTS_PER_TICK = 3;
const GOOGLE_SECRET = process.env.GOOGLE_OAUTH_SECRET_NAME || "elettro-brand-os-dev/google-oauth";
const TOKEN_PREFIX = process.env.YOUTUBE_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/youtube/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
// YouTube wants every chunk but the last to be a multiple of 256 KiB.
const CHUNK = 64 * 1024 * 1024;
const PRIVACY = ["private", "unlisted", "public"];

const result = (statusCode, payload) => ({ statusCode, ...payload });

// Validates the invoke payload into an upload request, or throws with a readable reason.
export function uploadRequest(event) {
  const channelId = String(event.channelId || "");
  if (!/^UC[A-Za-z0-9_-]{10,40}$/.test(channelId)) throw new Error("channelId must be a YouTube channel id (UC...)");
  const dropboxPath = String(event.dropboxPath || "").replace(/\\/g, "/");
  if (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  }
  const title = String(event.title || "").trim();
  if (!title || title.length > 100 || /[<>]/.test(title)) throw new Error("title needs 1-100 characters and no < or >");
  const description = String(event.description || "");
  if (description.length > 5000 || /[<>]/.test(description)) throw new Error("description allows up to 5000 characters and no < or >");
  const tags = Array.isArray(event.tags) ? event.tags.map(String) : [];
  if (tags.join(",").length > 500) throw new Error("tags add up to more than 500 characters");
  const privacyStatus = event.privacyStatus || "private";
  if (!PRIVACY.includes(privacyStatus)) throw new Error(`privacyStatus must be one of ${PRIVACY.join(", ")}`);
  return {
    channelId, dropboxPath, privacyStatus,
    snippet: { title, description, tags, categoryId: String(event.categoryId || "10") },
    madeForKids: event.madeForKids === true
  };
}

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function googleAccessToken(channelId) {
  const [client, token] = await Promise.all([secretJson(GOOGLE_SECRET), secretJson(TOKEN_PREFIX + channelId)]);
  if (!client.clientId || !client.clientSecret || !token.refreshToken) throw new Error("Google OAuth configuration is incomplete");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: token.refreshToken,
      client_id: client.clientId, client_secret: client.clientSecret
    }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google token refresh failed (HTTP ${response.status} ${body.error || ""})`.trim());
  return body.access_token;
}

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

// A short-lived direct link we can read in byte ranges, plus the file size.
async function dropboxFile(path) {
  const token = await dropboxAccessToken();
  const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${response.status}: ${(await response.text()).slice(0, 200)})`);
  const { link, metadata } = await response.json();
  return { link, size: Number(metadata.size), name: metadata.name };
}

async function startSession(accessToken, request, size) {
  const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/*"
    },
    body: JSON.stringify({
      snippet: request.snippet,
      status: { privacyStatus: request.privacyStatus, selfDeclaredMadeForKids: request.madeForKids }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const session = response.headers.get("location");
  if (!response.ok || !session) throw new Error(`YouTube refused the upload (HTTP ${response.status}: ${(await response.text()).slice(0, 300)})`);
  return session;
}

// Streams the file across in chunks: read a byte range from Dropbox, send it to YouTube.
async function sendChunks(session, file) {
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const end = Math.min(file.size, offset + CHUNK) - 1;
    const part = await fetch(file.link, { headers: { range: `bytes=${offset}-${end}` }, signal: AbortSignal.timeout(300000) });
    const bytes = Buffer.from(await part.arrayBuffer());
    if (!part.ok || bytes.length !== end - offset + 1) throw new Error(`Dropbox read failed at byte ${offset} (HTTP ${part.status})`);
    const response = await fetch(session, {
      method: "PUT",
      headers: { "content-range": `bytes ${offset}-${end}/${file.size}` },
      body: bytes,
      signal: AbortSignal.timeout(300000)
    });
    if (response.status === 308) continue;
    if (response.ok) return response.json();
    throw new Error(`YouTube upload failed at byte ${offset} (HTTP ${response.status}: ${(await response.text()).slice(0, 300)})`);
  }
  throw new Error("YouTube never confirmed the upload");
}

async function uploadVideo(request) {
  const [accessToken, file] = await Promise.all([googleAccessToken(request.channelId), dropboxFile(request.dropboxPath)]);
  const session = await startSession(accessToken, request, file.size);
  const video = await sendChunks(session, file);
  console.log("Uploaded", file.name, "to", request.channelId, "as", video.id);
  return {
    videoId: video.id, url: `https://youtu.be/${video.id}`,
    privacyStatus: video.status?.privacyStatus, uploadStatus: video.status?.uploadStatus, bytes: file.size
  };
}

const clean = (text, max) => String(text || "").replace(/[<>]/g, "").trim().slice(0, max);

// A claimed ScheduledPost turned into upload fields: planner copy first, then the asset's own title.
export function uploadFromPost(post, privacyStatus) {
  const tags = (post.hashtags || []).map((h) => String(h).replace(/^#/, "")).filter(Boolean);
  const hashtagLine = tags.map((t) => `#${t}`).join(" ");
  return {
    channelId: post.channelId,
    dropboxPath: post.dropboxPath,
    title: clean(post.title, 100) || clean(post.assetTitle, 100) || clean(String(post.filename || "").replace(/\.[^.]+$/, ""), 100),
    description: clean([post.caption, hashtagLine].filter(Boolean).join("\n\n"), 5000),
    tags,
    privacyStatus
  };
}

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

async function publishingTick() {
  const planning = await api({ action: "planner-tick" }).catch((error) => ({ ok: false, error: error.message }));
  const claimed = await api({ action: "claim-due-posts", destination: "youtube", limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const video = await uploadVideo(uploadRequest(uploadFromPost(post, SCHEDULED_PRIVACY)));
      outcome = { externalPostId: video.videoId, externalUrl: video.url };
    } catch (error) {
      console.error("Scheduled upload failed:", post.id, error?.message);
      outcome = { error: error?.message || "Upload failed" };
    }
    await api({ action: "finish-post", id: post.id, ...outcome });
    published.push({ id: post.id, ...outcome });
  }
  const summary = { ok: true, planning, missed: claimed.missed, stuck: claimed.stuck, published };
  console.log("Tick", JSON.stringify(summary));
  return result(200, summary);
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick") {
    try { return await publishingTick(); } catch (error) {
      console.error("Tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  let request;
  try { request = uploadRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
  try {
    return result(200, { ok: true, ...(await uploadVideo(request)) });
  } catch (error) {
    console.error("YouTube upload failed:", error?.message || "Unknown error");
    return result(502, { ok: false, error: error?.message || "Upload failed" });
  }
}
