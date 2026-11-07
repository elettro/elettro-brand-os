import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// X (Twitter) worker for Elettro OS. Runs outside the VPC (it needs api.x.com and Dropbox) and is only invoked
// directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   publish approved X posts whose time has come
//                                             (planner claim-due-posts / finish-post)
//   { action: "post", brand | accountKey, text, dropboxPaths? | dropboxPath? }
//                                             publish now: text only, 1-4 Dropbox images, or one Dropbox video
//
// Post shape (POST https://api.x.com/2/tweets): up to 280 characters (a link counts as 23), media_ids for up to 4
// images. Images go up first through POST /2/media/upload (scope media.write). Video uses X's chunked upload
// (docs.x.com, read 2026-11-06): POST /2/media/upload/initialize (JSON: media_type, total_bytes, media_category tweet_video),
// POST /2/media/upload/{id}/append (multipart: segment_index, media; chunks of 4 MiB, X's limit is 5 MB),
// POST /2/media/upload/{id}/finalize, then GET /2/media/upload?command=STATUS&media_id=... until processing_info.state is
// succeeded. X allows 20 minutes / 8 GB per post video; we cap at 1 GB (a 4 MiB part per Dropbox read keeps memory small; the 900 s Lambda timeout is the real limit). The Lambda holds one 4 MiB chunk at a time, read
// from Dropbox with Range requests, so memory stays small. Placements published: post (1 image), carousel (2-4 images), video.
//
// Auth: OAuth 2.0 user tokens live in Secrets Manager (elettro-brand-os-dev/x/<numeric user id>, written by the
// dev-api's /connections/x/complete). The access token lasts ~2 hours and the refresh token ROTATES on use (the old
// one dies the moment X issues the new one), so every use refreshes when under a minute is left and writes the new
// pair straight back. The web app does the same for the Connections test post, so the two share one secret.
// Cost (X pay-per-use, checked 2026-10-30): $0.015 per post, $0.20 for a post that contains a URL. Dean approved the spend 2026-11-06.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
const TOKEN_PREFIX = process.env.X_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/x/";
const APP_SECRET = process.env.X_APP_SECRET_NAME || "elettro-brand-os-dev/x-oauth";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
export const MAX_TEXT = 280; // a link counts as 23 whatever its length
export const MAX_TAGS = 2;
export const MAX_IMAGES = 4;
export const IMAGE_BYTE_LIMIT = 5 * 1024 * 1024; // X: 5 MB for a JPEG/PNG/WebP
export const MAX_ALT = 1000;
export const VIDEO_BYTE_LIMIT = 1024 * 1024 * 1024; // our cap; X itself allows 8 GB / 20 minutes
export const CHUNK_BYTES = 4 * 1024 * 1024; // X: at most 5 MB per append segment
const STATUS_POLL_LIMIT_MS = 420_000;
const PLACEMENTS = ["post", "carousel", "video"];
const POSTS_PER_TICK = 1;
const URL_LENGTH = 23;

const result = (statusCode, payload) => ({ statusCode, ...payload });

// ---------- text ----------

// X weights: every link is 23 characters, everything else one code point; emoji count 2 here to stay on the safe side.
export function weight(text) {
  let n = 0;
  const stripped = String(text).replace(/https?:\/\/\S+/g, () => { n += URL_LENGTH; return ""; });
  for (const ch of stripped) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  return n;
}
function truncate(text, max) {
  if (weight(text) <= max) return String(text);
  let out = "";
  for (const w of String(text).split(/(\s+)/)) {
    if (weight(out + w + "…") > max) break;
    out += w;
  }
  return out.trimEnd() + "…";
}

// Automated posts never @mention another account: X treats that as spam and can suspend the app.
const MENTION = /(^|[\s(])@[a-z0-9_]{1,15}\b/i;
export function complianceProblems(text) {
  return MENTION.test(String(text)) ? ["a scheduled X post may not @mention another account (automated mentions count as spam)"] : [];
}

// GLOBAL RULE, every brand: NO URL POSTS ON X. X bills $0.20 for a post containing a URL against $0.015 for one without
// (13x), and it also treats a bare domain such as stashbox.com/radio as a link. So no text we send carries a link of any kind.
const SCHEME_URL = /(?:https?:\/\/|\bwww\.)\S+/gi;
const BARE_DOMAIN = /(?<![@\w#])[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|de|co|us|tv|fm|app|shop|radio|info|biz|me|ly|gg|xyz|online|site|store|link|page|dev|eu)\b(?:\/\S*)?/gi;
export const hasUrl = (text) => { const t = String(text || ""); return new RegExp(SCHEME_URL.source, "i").test(t) || new RegExp(BARE_DOMAIN.source, "i").test(t); };
export function stripUrls(text) {
  return String(text || "").replace(SCHEME_URL, "").replace(BARE_DOMAIN, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Planner caption (links removed, see NO URL POSTS above) plus up to two #tags, within 280 weighted characters (the caption is cut, never the tags). */
export function postText(caption, hashtags = []) {
  const tags = (hashtags || []).map((h) => String(h).replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).slice(0, MAX_TAGS);
  const body = stripUrls(caption);
  if (!tags.length) return truncate(body, MAX_TEXT);
  const suffix = "\n\n" + tags.map((t) => "#" + t).join(" ");
  if (weight(suffix) >= MAX_TEXT) return truncate(body, MAX_TEXT);
  return (truncate(body, MAX_TEXT - weight(suffix)) + suffix).trim();
}

// ---------- requests ----------

const safePath = (value) => {
  const path = String(value || "").replace(/\\/g, "/");
  if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  return path;
};
const IMAGE = /\.(jpe?g|png|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4" };
export const mimeOf = (path) => MIME[String(path).split(".").pop().toLowerCase()] || "application/octet-stream";
const ACCOUNT_KEY = /^[0-9]{1,25}$/; // the numeric X user id, also the tail of the token secret's name

// A manual post: text, 1-4 images, or one video.
export function postRequest(event) {
  const text = String(event.text || "").trim();
  if (hasUrl(text)) throw new Error("X posts may not contain a URL or domain (a link costs 13x as much); remove it");
  if (weight(text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const paths = (Array.isArray(event.dropboxPaths) ? event.dropboxPaths : event.dropboxPath ? [event.dropboxPath] : []).map(safePath);
  if (!paths.length && !text) throw new Error("a post needs text, Dropbox images, or both");
  if (paths.length > MAX_IMAGES) throw new Error(`an X post holds up to ${MAX_IMAGES} images`);
  const video = paths.length === 1 && VIDEO.test(paths[0]);
  if (!video && !paths.every((p) => IMAGE.test(p))) throw new Error("use up to 4 .jpg/.png/.webp images, or exactly one .mp4/.mov/.m4v video (not both)");
  const brand = String(event.brand || "");
  const accountKey = String(event.accountKey || "");
  if (!accountKey && !/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("give a brand slug such as stashbox, or an accountKey");
  if (accountKey && !ACCOUNT_KEY.test(accountKey)) throw new Error("accountKey is the numeric X user id");
  return { brand, accountKey, text, paths, kind: video ? "video" : "images" };
}

export function requestFromPost(post) {
  const text = postText(post.caption, post.hashtags);
  const broken = complianceProblems(text);
  if (broken.length) throw new Error(broken.join("; "));
  const accountKey = String(post.channelId || "");
  if (!ACCOUNT_KEY.test(accountKey)) throw new Error("This post's X account is not linked (reconnect it on /connections)");
  const alt = String(post.altText || post.caption || post.title || "").trim().slice(0, MAX_ALT);
  if (post.placement === "video") {
    const path = safePath(post.dropboxPath);
    if (!VIDEO.test(path)) throw new Error("an X video must be an .mp4, .mov or .m4v file");
    return { text, paths: [path], alt, accountKey, kind: "video" };
  }
  if (post.placement === "carousel") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < 2 || slides.length > MAX_IMAGES) throw new Error(`an X multi-photo post needs 2-${MAX_IMAGES} images; this one has ${slides.length}`);
    const paths = slides.map((s) => safePath(s.dropboxPath));
    if (!paths.every((p) => IMAGE.test(p))) throw new Error("every slide must be a .jpg, .png or .webp image");
    return { text, paths, alt, accountKey, kind: "images" };
  }
  const path = safePath(post.dropboxPath);
  if (!IMAGE.test(path)) throw new Error("an X photo post needs a .jpg, .png or .webp image");
  return { text, paths: [path], alt, accountKey, kind: "images" };
}

// ---------- Secrets Manager + dev-api ----------

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

/**
 * A usable login for the account: the saved access token while it has over a minute left, otherwise refresh and save the
 * rotated pair. The old refresh token stops working the moment X issues the new one, so the write-back is not optional.
 */
export async function account(accountKey, deps = {}) {
  const {
    read = secretJson,
    write = (id, value) => secrets.send(new PutSecretValueCommand({ SecretId: id, SecretString: JSON.stringify(value) })),
    fetchImpl = fetch, now = Date.now
  } = deps;
  const name = TOKEN_PREFIX + accountKey;
  const saved = await read(name).catch(() => null);
  if (!saved?.accessToken || saved.revokedAt) throw new Error(`No X login is stored for ${accountKey}; reconnect it on /connections`);
  const left = saved.expiresAt ? Date.parse(saved.expiresAt) - now() : 0;
  if (left > 60_000) return saved;
  if (!saved.refreshToken) throw new Error(`The X login for @${saved.username} expired; reconnect it on /connections`);
  const app = await read(APP_SECRET);
  if (!app.clientId || !app.clientSecret) throw new Error("The X app is not set up (elettro-brand-os-dev/x-oauth)");
  const response = await fetchImpl("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: app.clientId }),
    signal: AbortSignal.timeout(20000)
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) throw new Error(`The X login for @${saved.username} expired; reconnect it on /connections (${token.error_description || token.error || response.status})`);
  const next = {
    ...saved, accessToken: token.access_token, refreshToken: token.refresh_token || saved.refreshToken,
    expiresAt: new Date(now() + (token.expires_in || 7200) * 1000).toISOString(), scope: token.scope || saved.scope
  };
  await write(name, next);
  return next;
}

/** The numeric X user id connected for a brand (manual posts). */
export async function accountKeyForBrand(brand, deps = {}) {
  const { callApi = api } = deps;
  const out = await callApi({ action: "list-social-accounts", destination: "x" });
  const row = (out.accounts || []).find((a) => a.brand === brand);
  if (!row || !ACCOUNT_KEY.test(String(row.externalAccountId || ""))) throw new Error(`No X account is connected for ${brand}`);
  return String(row.externalAccountId);
}

// ---------- Dropbox ----------

async function dropboxAccessToken() {
  const config = await secretJson(DROPBOX_SECRET);
  const refreshToken = config.refresh_token || config.refreshToken;
  const appKey = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!refreshToken || !appKey || !appSecret) throw new Error("Dropbox OAuth refresh configuration is incomplete");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox refresh failed (HTTP ${response.status})`);
  return (await response.json()).access_token;
}

async function dropboxLink(path) {
  const linkResponse = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST", headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(20000)
  });
  if (!linkResponse.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${linkResponse.status})`);
  return (await linkResponse.json()).link;
}

/** A video read in pieces: its size, and any byte range [start, end) through an HTTP Range request on a temporary link. */
export async function dropboxSource(path) {
  const link = await dropboxLink(path);
  const probe = await fetch(link, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(30000) });
  const total = Number(/\/(\d+)\s*$/.exec(probe.headers.get("content-range") || "")?.[1]);
  if (probe.status !== 206 || !Number.isFinite(total) || total < 1) throw new Error(`Dropbox did not report the size of ${path}`);
  return {
    size: total,
    read: async (start, end) => {
      const part = await fetch(link, { headers: { range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(120000) });
      if (part.status !== 206 && part.status !== 200) throw new Error(`Dropbox download failed for ${path} (HTTP ${part.status})`);
      return Buffer.from(await part.arrayBuffer());
    }
  };
}

async function dropboxBytes(path) {
  const file = await fetch(await dropboxLink(path), { signal: AbortSignal.timeout(120000) });
  if (!file.ok) throw new Error(`Dropbox download failed for ${path} (HTTP ${file.status})`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------- publishing ----------

async function xcall(record, method, path, { body, headers, fetchImpl = fetch } = {}) {
  const init = { method, headers: { authorization: `Bearer ${record.accessToken}`, ...(headers || {}) }, signal: AbortSignal.timeout(120000) };
  if (body !== undefined) init.body = body;
  const response = await fetchImpl("https://api.x.com" + path, init);
  const out = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error(`X rejected the login for @${record.username}; reconnect it on /connections`);
  if (response.status === 402) throw new Error("X refused the call because the developer account is out of credits; top up in the X Developer Console");
  return { status: response.status, ok: response.ok, out };
}
const why = (out, status) => out?.detail || out?.title || out?.errors?.[0]?.message || status;

/** Upload one image and return its media id; alt text is best effort (a failure there never blocks the post). */
export async function uploadImage(record, bytes, name, path, alt, deps = {}) {
  const { fetchImpl = fetch } = deps;
  if (bytes.length > IMAGE_BYTE_LIMIT) throw new Error(`This image is ${(bytes.length / 1048576).toFixed(1)} MB; X allows up to 5 MB`);
  const form = new FormData();
  form.append("media", new Blob([bytes], { type: mimeOf(path) }), name);
  form.append("media_category", "tweet_image");
  form.append("media_type", mimeOf(path));
  const up = await xcall(record, "POST", "/2/media/upload", { body: form, fetchImpl });
  const id = up.out?.data?.id;
  if (!up.ok || !id) throw new Error(`X media upload failed: ${why(up.out, up.status)}`);
  if (alt) {
    await xcall(record, "POST", "/2/media/metadata", {
      fetchImpl, headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, metadata: { alt_text: { text: String(alt).slice(0, MAX_ALT) } } })
    }).catch((error) => console.error("X alt text failed:", error?.message));
  }
  return String(id);
}

/** Upload one video through X's chunked upload and wait until X has processed it. Returns the media id. */
export async function uploadVideo(record, path, deps = {}) {
  const { fetchImpl = fetch, source = dropboxSource, wait = (ms) => new Promise((r) => setTimeout(r, ms)), limitMs = STATUS_POLL_LIMIT_MS } = deps;
  const src = await source(path);
  if (src.size > VIDEO_BYTE_LIMIT) throw new Error(`This video is ${(src.size / 1048576).toFixed(0)} MB; Elettro OS sends X videos up to ${VIDEO_BYTE_LIMIT / 1048576} MB`);
  const init = await xcall(record, "POST", "/2/media/upload/initialize", {
    fetchImpl, headers: { "content-type": "application/json" },
    body: JSON.stringify({ media_type: mimeOf(path), total_bytes: src.size, media_category: "tweet_video" })
  });
  const id = init.out?.data?.id;
  if (!init.ok || !id) throw new Error(`X video upload could not start: ${why(init.out, init.status)}`);
  let index = 0;
  for (let start = 0; start < src.size; start += CHUNK_BYTES, index += 1) {
    const form = new FormData();
    form.append("segment_index", String(index));
    form.append("media", new Blob([await src.read(start, Math.min(start + CHUNK_BYTES, src.size))]), `part${index}`);
    const part = await xcall(record, "POST", `/2/media/upload/${encodeURIComponent(id)}/append`, { body: form, fetchImpl });
    if (!part.ok) throw new Error(`X video upload failed at part ${index + 1}: ${why(part.out, part.status)}`);
  }
  const done = await xcall(record, "POST", `/2/media/upload/${encodeURIComponent(id)}/finalize`, { fetchImpl });
  if (!done.ok) throw new Error(`X video upload could not finish: ${why(done.out, done.status)}`);
  let info = done.out?.data?.processing_info;
  let waited = 0;
  while (info && info.state !== "succeeded") {
    if (info.state === "failed") throw new Error(`X could not process the video: ${info.error?.message || info.error?.name || "unknown reason"}`);
    const pause = Math.min(Math.max(Number(info.check_after_secs) || 5, 1), 30) * 1000;
    if (waited + pause > limitMs) throw new Error(`X was still processing the video after ${Math.round(waited / 1000)} s`);
    await wait(pause);
    waited += pause;
    const status = await xcall(record, "GET", `/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`, { fetchImpl });
    if (!status.ok) throw new Error(`X video status check failed: ${why(status.out, status.status)}`);
    info = status.out?.data?.processing_info;
  }
  return String(id);
}

/** Upload the images or the video, then create the post. Returns its id and URL. */
export async function publish(record, request, deps = {}) {
  const { download = dropboxBytes, fetchImpl = fetch } = deps;
  if (weight(request.text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const ids = [];
  if (request.kind === "video") ids.push(await uploadVideo(record, request.paths[0], deps));
  else for (const path of request.paths) ids.push(await uploadImage(record, await download(path), path.split("/").pop(), path, request.alt, deps));
  const created = await xcall(record, "POST", "/2/tweets", {
    fetchImpl, headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: request.text, ...(ids.length ? { media: { media_ids: ids } } : {}) })
  });
  const id = created.out?.data?.id;
  if (!created.ok || !id) throw new Error(`X refused the post: ${why(created.out, created.status)}`);
  return { id: String(id), url: `https://x.com/${record.username}/status/${id}`, handle: "@" + record.username };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, find = account, send = publish } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "x", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const record = await find(request.accountKey);
      const sent = await send(record, request);
      outcome = { externalPostId: sent.id, externalUrl: sent.url };
    } catch (error) {
      console.error("Scheduled X post failed:", post.id, error?.message);
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
    try {
      const tick = await publishingTick();
      console.log("X tick", JSON.stringify(tick));
      return result(200, { ok: true, ...tick });
    } catch (error) {
      console.error("X tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const key = request.accountKey || await accountKeyForBrand(request.brand);
      const record = await account(key);
      const posted = await publish(record, { ...request, alt: String(event.alt || "") });
      console.log("X post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("X post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
