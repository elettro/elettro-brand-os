import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Mastodon worker for Elettro OS. Runs outside the VPC (it needs the Mastodon instance and Dropbox) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   publish approved Mastodon posts whose time has come
//                                             (planner claim-due-posts / finish-post)
//   { action: "post", brand, text, dropboxPaths? | dropboxPath? }
//                                             publish now: text only, 1-4 Dropbox images, or one Dropbox video
//
// Mastodon status shape (POST /api/v1/statuses): up to 500 characters (a link counts as 23), and at most one kind of
// media: up to 4 images OR one video. Media is uploaded first (POST /api/v2/media; video is processed asynchronously,
// so it is polled until ready). Placements published: post (1 image), carousel (2-4 images), video.
//
// Auth: each account's access token lives in Secrets Manager (elettro-brand-os-dev/mastodon/<account id>@<instance>,
// written by the dev-api's /connections/mastodon/complete). Mastodon tokens never expire and have no refresh token,
// so there is nothing to renew; a revoked token shows up as a 401 and the account must be reconnected.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
const TOKEN_PREFIX = process.env.MASTODON_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/mastodon/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
export const MAX_TEXT = 500; // characters (code points)
export const MAX_TAGS = 3;
export const MAX_IMAGES = 4;
export const IMAGE_BYTE_LIMIT = 16 * 1024 * 1024; // mastodon.social
export const VIDEO_BYTE_LIMIT = 99 * 1024 * 1024; // mastodon.social
export const MAX_ALT = 1500;
const PLACEMENTS = ["post", "carousel", "video"];
const POSTS_PER_TICK = 1;
const POLL_MS = 3000;
const POLL_LIMIT_MS = 240_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

// ---------- text ----------

const chars = (text) => [...String(text)].length;
function truncate(text, max) {
  const parts = [...String(text)];
  if (parts.length <= max) return String(text);
  let cut = parts.slice(0, max - 1).join("");
  // A cut inside a link would leave a broken URL; back up to before it.
  for (const m of String(text).matchAll(/https?:\/\/\S+/g)) {
    if (m.index < cut.length && m.index + m[0].length > cut.length) { cut = cut.slice(0, m.index); break; }
  }
  return cut.trimEnd() + "…";
}

// Scheduled (automated) posts never @mention another account: it notifies them, which counts as spam.
const MENTION = /(^|[\s(])@[a-z0-9_]+(@[a-z0-9.-]+\.[a-z]{2,})?/i;
export function complianceProblems(text) {
  return MENTION.test(String(text)) ? ["a scheduled Mastodon post may not @mention another account (automated notifications count as spam)"] : [];
}

/** Planner caption plus up to three #tags, within 500 characters (the caption is cut, never the tags). */
export function postText(caption, hashtags = []) {
  const tags = (hashtags || []).map((h) => String(h).replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean).slice(0, MAX_TAGS);
  const body = String(caption || "").trim();
  if (!tags.length) return truncate(body, MAX_TEXT);
  const suffix = "\n\n" + tags.map((t) => "#" + t).join(" ");
  if (chars(suffix) >= MAX_TEXT) return truncate(body, MAX_TEXT);
  return (truncate(body, MAX_TEXT - chars(suffix)) + suffix).trim();
}

// ---------- requests ----------

const safePath = (value) => {
  const path = String(value || "").replace(/\\/g, "/");
  if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  return path;
};
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm" };
export const mimeOf = (path) => MIME[String(path).split(".").pop().toLowerCase()] || "application/octet-stream";
// An account id plus its instance, e.g. 109876@mastodon.social; also the tail of the token secret's name.
const ACCOUNT_KEY = /^[A-Za-z0-9_.-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// A manual post: text, 1-4 images, or one video.
export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as stashbox");
  const text = String(event.text || "").trim();
  if (chars(text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const paths = (Array.isArray(event.dropboxPaths) ? event.dropboxPaths : event.dropboxPath ? [event.dropboxPath] : []).map(safePath);
  if (!paths.length && !text) throw new Error("a post needs text, Dropbox images, a Dropbox video, or both");
  if (paths.length > MAX_IMAGES) throw new Error(`a Mastodon post holds up to ${MAX_IMAGES} images`);
  if (!paths.length) return { brand, text, kind: "text", paths };
  if (paths.every((p) => IMAGE.test(p))) return { brand, text, kind: "images", paths };
  if (paths.length === 1 && VIDEO.test(paths[0])) return { brand, text, kind: "video", paths };
  throw new Error("use up to 4 .jpg/.png/.webp/.gif images, or exactly one .mp4/.mov/.webm video (not both)");
}

export function requestFromPost(post) {
  const text = postText(post.caption, post.hashtags);
  const broken = complianceProblems(text);
  if (broken.length) throw new Error(broken.join("; "));
  const accountKey = String(post.channelId || "");
  if (!ACCOUNT_KEY.test(accountKey)) throw new Error("This post's Mastodon account is not linked (reconnect it on /connections)");
  const alt = String(post.altText || post.caption || post.title || "").trim().slice(0, MAX_ALT);
  const idempotencyKey = `elettro-os-${post.id}`; // a retried claim can never publish the same post twice
  if (post.placement === "carousel") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < 2 || slides.length > MAX_IMAGES) throw new Error(`a Mastodon multi-photo post needs 2-${MAX_IMAGES} images; this one has ${slides.length}`);
    const paths = slides.map((s) => safePath(s.dropboxPath));
    if (!paths.every((p) => IMAGE.test(p))) throw new Error("every slide must be a .jpg, .png, .webp or .gif image");
    return { brand: "planner", text, kind: "images", paths, alt, accountKey, idempotencyKey };
  }
  if (post.placement === "video") {
    const path = safePath(post.dropboxPath);
    if (!VIDEO.test(path)) throw new Error("a Mastodon video must be an .mp4, .mov, .m4v or .webm file");
    return { brand: "planner", text, kind: "video", paths: [path], alt, accountKey, idempotencyKey };
  }
  const path = safePath(post.dropboxPath);
  if (!IMAGE.test(path)) throw new Error("a Mastodon photo post needs a .jpg, .png, .webp or .gif image");
  return { brand: "planner", text, kind: "images", paths: [path], alt, accountKey, idempotencyKey };
}

// ---------- Secrets Manager + dev-api ----------

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

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

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

/** The stored login for an account key (planner posts) or a brand (manual posts). */
export async function account(brand, accountKey, deps = {}) {
  const { names = tokenSecretNames, read = secretJson } = deps;
  if (accountKey) {
    const record = await read(TOKEN_PREFIX + accountKey).catch(() => null);
    if (!record?.accessToken || record.revokedAt) throw new Error(`No Mastodon login is stored for ${accountKey}; reconnect it on /connections`);
    return record;
  }
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    if (record.revokedAt || !record.accessToken || record.brand !== brand) continue;
    return record;
  }
  throw new Error(`No Mastodon account is connected for ${brand}`);
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

async function dropboxBytes(path) {
  const linkResponse = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST", headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(20000)
  });
  if (!linkResponse.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${linkResponse.status})`);
  const file = await fetch((await linkResponse.json()).link, { signal: AbortSignal.timeout(120000) });
  if (!file.ok) throw new Error(`Dropbox download failed for ${path} (HTTP ${file.status})`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------- publishing ----------

const base = (record) => `https://${String(record.instance).replace(/^https?:\/\//, "")}`;

async function mastodon(record, method, path, { body, headers, fetchImpl = fetch } = {}) {
  const init = { method, headers: { authorization: `Bearer ${record.accessToken}`, ...(headers || {}) }, signal: AbortSignal.timeout(120000) };
  if (body !== undefined) init.body = body;
  const response = await fetchImpl(base(record) + path, init);
  const out = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error(`Mastodon rejected the login for @${record.acct || record.accountId}; reconnect it on /connections`);
  return { status: response.status, ok: response.ok, out };
}

/** Upload one file; video is processed after the upload (HTTP 202), so poll until the media is ready. */
export async function uploadMedia(record, bytes, name, path, alt, deps = {}) {
  const { fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  const video = VIDEO.test(path);
  if (video && bytes.length > VIDEO_BYTE_LIMIT) throw new Error(`This video is ${(bytes.length / 1048576).toFixed(0)} MB; Mastodon allows up to 99 MB`);
  if (!video && bytes.length > IMAGE_BYTE_LIMIT) throw new Error(`This image is ${(bytes.length / 1048576).toFixed(0)} MB; Mastodon allows up to 16 MB`);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeOf(path) }), name);
  if (alt) form.append("description", String(alt).slice(0, MAX_ALT));
  const first = await mastodon(record, "POST", "/api/v2/media", { body: form, fetchImpl });
  if (!first.ok || !first.out.id) throw new Error(`Mastodon media upload failed: ${first.out.error || first.status}`);
  if (first.status === 200) return first.out.id;
  for (let waited = 0; ; waited += pollMs) {
    await wait(pollMs);
    const poll = await mastodon(record, "GET", `/api/v1/media/${encodeURIComponent(first.out.id)}`, { fetchImpl });
    if (poll.status === 200 && poll.out.url) return first.out.id;
    if (poll.status >= 400) throw new Error(`Mastodon could not process the media: ${poll.out.error || poll.status}`);
    if (waited >= limitMs) throw new Error(`Mastodon was still processing the media after ${Math.round(limitMs / 1000)} s`);
  }
}

/** Upload the media, then create the public status. Returns its id and URL. */
export async function publish(record, request, deps = {}) {
  const { download = dropboxBytes, fetchImpl = fetch } = deps;
  const text = request.text;
  if (chars(text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const ids = [];
  for (const path of request.paths) {
    ids.push(await uploadMedia(record, await download(path), path.split("/").pop(), path, request.alt, deps));
  }
  const status = await mastodon(record, "POST", "/api/v1/statuses", {
    fetchImpl,
    headers: { "content-type": "application/json", "idempotency-key": request.idempotencyKey || `elettro-os-${Date.now()}` },
    body: JSON.stringify({ status: text, visibility: "public", ...(ids.length ? { media_ids: ids } : {}) })
  });
  if (!status.ok || !status.out.url) throw new Error(`Mastodon refused the post: ${status.out.error || status.status}`);
  return { id: String(status.out.id), url: status.out.url, handle: record.acct ? "@" + record.acct : record.accountId };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, find = account, send = publish } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "mastodon", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const record = await find(null, request.accountKey);
      const sent = await send(record, request);
      outcome = { externalPostId: sent.id, externalUrl: sent.url };
    } catch (error) {
      console.error("Scheduled Mastodon post failed:", post.id, error?.message);
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
      console.log("Mastodon tick", JSON.stringify(tick));
      return result(200, { ok: true, ...tick });
    } catch (error) {
      console.error("Mastodon tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const record = await account(request.brand);
      const posted = await publish(record, { ...request, alt: String(event.alt || "") });
      console.log("Mastodon post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("Mastodon post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
