import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Pinterest worker for Elettro OS. Runs outside the VPC (it needs api.pinterest.com) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   the tick: renew tokens close to expiry, then publish
//                                             approved Pinterest posts whose time has come
//                                             (planner claim-due-posts / finish-post)
//   { action: "refresh" }                     renew tokens only, on demand
// One Pinterest account (pinterest.com/elettro) serves several brands; each brand pins to its own
// board (BOARDS, created on first use). Images go up by URL (a 4-hour Dropbox link Pinterest
// fetches); videos are copied from Dropbox into Pinterest's upload form, processed, then pinned.
// A carousel Pin (placement "carousel", 2-5 images) is one Pin with media_source multiple_image_urls; the
// planner's claim-due-posts only hands carousels to a worker that asks for them.
// Access tokens last 30 days. With continuous refresh, each renewal also returns a new refresh
// token, so an account that keeps posting never needs reconnecting.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the app secret (elettro-brand-os-dev/pinterest-oauth) out of the list.
const TOKEN_PREFIX = process.env.PINTEREST_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/pinterest/";
const APP_SECRET = process.env.PINTEREST_APP_SECRET_NAME || "elettro-brand-os-dev/pinterest-oauth";
const APP_ID = process.env.PINTEREST_APP_ID || "1627333";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const API = "https://api.pinterest.com/v5";
// Board per brand; brands not listed use their slug in title case.
export const BOARDS = { elettro: "Elettro Digital Marketing Agency", stashbox: "Stashbox" };
// Pinterest limits.
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 800;
// Images per carousel Pin.
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 5;
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
// The planner placements this worker publishes.
const PLACEMENTS = ["pin", "video", "carousel"];
// One post per tick keeps a backlog from bursting onto the feed.
const POSTS_PER_TICK = 1;
// Video processing: poll every 5 s for up to 8 minutes (Lambda timeout 15 min).
const POLL_MS = 5000;
const POLL_LIMIT_MS = 480_000;
// Renew when the access token has under 7 days left; checked every tick.
const RENEW_WITHIN_MS = 7 * 86_400_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

export function needsRefresh(record, now = new Date()) {
  if (!record?.refreshToken) return false;
  const refreshExpires = Date.parse(record.refreshExpiresAt || "");
  if (Number.isFinite(refreshExpires) && refreshExpires <= now.getTime()) return false;
  const expires = Date.parse(record.accessExpiresAt || "");
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

export async function refreshRecord(record, clientSecret, now = new Date(), post = fetch) {
  const response = await post(`${API}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${APP_ID}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Pinterest refresh failed: ${body.message || response.status}`);
  const at = (seconds, fallbackDays) => new Date(now.getTime() + (Number(seconds) > 0 ? Number(seconds) : fallbackDays * 86_400) * 1000).toISOString();
  return {
    ...record,
    accessToken: body.access_token,
    accessExpiresAt: at(body.expires_in, 30),
    // Continuous refresh returns a new refresh token; keep the old one if this response has none.
    ...(body.refresh_token ? { refreshToken: body.refresh_token, refreshExpiresAt: at(body.refresh_token_expires_in, 60) } : {}),
    refreshedAt: now.toISOString()
  };
}

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

export async function refreshAll(now = new Date(), deps = {}) {
  const { names = tokenSecretNames, read = secretJson, write = (SecretId, record) =>
    secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) })), refresh = refreshRecord, callApi = api,
    appSecret = async () => (await secretJson(APP_SECRET)).clientSecret } = deps;
  const accounts = [];
  let clientSecret;
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    const handle = record.username ? "@" + record.username : record.userId;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, accessExpiresAt: record.accessExpiresAt }); continue; }
    try {
      clientSecret ||= await appSecret();
      if (!clientSecret) throw new Error(`${APP_SECRET} has no clientSecret`);
      const next = await refresh(record, clientSecret, now);
      await write(SecretId, next);
      const entry = { handle, refreshed: true, accessExpiresAt: next.accessExpiresAt };
      // The token is safe once written; a stale countdown is only cosmetic, so report it and carry on.
      const moved = await callApi({ action: "set-token-expiry", destination: "pinterest", externalAccountId: record.userId, tokenExpiresAt: next.refreshExpiresAt })
        .catch((error) => ({ ok: false, error: error?.message }));
      if (!moved.ok) entry.countdownError = moved.error || "set-token-expiry failed";
      accounts.push(entry);
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("Pinterest refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("Pinterest refresh", JSON.stringify(summary));
  return summary;
}

const titleCase = (slug) => String(slug || "").split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
export const boardNameFor = (brand) => BOARDS[brand] || titleCase(brand);

// Planner post → Pin text. The title falls back to the caption's first line; the link is the one the copy picked.
export function pinFromPost(post) {
  const description = String(post.caption || "").trim().slice(0, MAX_DESCRIPTION);
  const title = String(post.title || description.split("\n")[0] || post.assetTitle || "").trim().slice(0, MAX_TITLE);
  if (!title) throw new Error("The post has no title or caption");
  const link = /^https:\/\/\S+$/.test(String(post.primaryLink || "")) ? post.primaryLink : null;
  if (post.placement === "carousel") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < CAROUSEL_MIN || slides.length > CAROUSEL_MAX) {
      throw new Error(`a Pinterest carousel needs ${CAROUSEL_MIN}-${CAROUSEL_MAX} images; this one has ${slides.length}`);
    }
    const slidePaths = slides.map((slide) => {
      const path = String(slide.dropboxPath || "").replace(/\\/g, "/");
      if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
      if (!/\.(jpe?g|png)$/i.test(path)) throw new Error("every carousel slide must be a .jpg or .png image");
      return path;
    });
    return { title, description, link, kind: "carousel", slidePaths, altText: String(post.assetTitle || title).slice(0, 500) };
  }
  const kind = post.assetKind === "video" || /\.(mp4|mov)$/i.test(post.dropboxPath || "") ? "video" : "image";
  return { title, description, link, kind, altText: String(post.assetTitle || title).slice(0, 500) };
}

// The token record for a Pinterest user id (planner posts carry it as channelId).
export async function account(userId, deps = {}) {
  const { read = secretJson, now = new Date() } = deps;
  if (!/^\d{5,25}$/.test(String(userId || ""))) throw new Error("The post has no Pinterest account id");
  const record = await read(TOKEN_PREFIX + userId);
  if (!record.accessToken) throw new Error(`No Pinterest token stored for ${userId}`);
  if (Date.parse(record.accessExpiresAt || "") <= now.getTime()) {
    throw new Error(`The Pinterest login for ${record.username ? "@" + record.username : userId} has expired; reconnect it on /connections`);
  }
  return record;
}

export async function pinterest(accessToken, method, path, body, call = fetch) {
  const response = await call(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Pinterest ${method} ${path.split("?")[0]} failed: ${out.message || response.status}`);
  return out;
}

// The brand's board on this account, created (public) when it doesn't exist yet.
export async function boardId(call, brand) {
  const name = boardNameFor(brand);
  let bookmark = null;
  do {
    const page = await call("GET", `/boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`);
    const found = (page.items || []).find((b) => b.name?.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    bookmark = page.bookmark || null;
  } while (bookmark);
  return (await call("POST", "/boards", { name, privacy: "PUBLIC" })).id;
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

// A 4-hour public link to the file.
async function dropboxLink(path) {
  const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${response.status}: ${(await response.text()).slice(0, 200)})`);
  return (await response.json()).link;
}

// Register the video, copy it from Dropbox into Pinterest's upload form, wait until processing succeeded.
async function uploadVideo(call, dropboxPath, filename, deps = {}) {
  const { link = dropboxLink, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  const registered = await call("POST", "/media", { media_type: "video" });
  const source = await fetch(await link(dropboxPath), { signal: AbortSignal.timeout(300000) });
  if (!source.ok) throw new Error(`Dropbox download failed (HTTP ${source.status})`);
  const form = new FormData();
  for (const [key, value] of Object.entries(registered.upload_parameters || {})) form.append(key, value);
  form.append("file", await source.blob(), filename || "video.mp4");
  const uploaded = await fetch(registered.upload_url, { method: "POST", body: form, signal: AbortSignal.timeout(300000) });
  if (!uploaded.ok) throw new Error(`Pinterest video upload failed (HTTP ${uploaded.status})`);
  for (let waited = 0; ; waited += pollMs) {
    const state = await call("GET", `/media/${registered.media_id}`);
    if (state.status === "succeeded") return registered.media_id;
    if (state.status === "failed") throw new Error("Pinterest could not process the video");
    if (waited >= limitMs) throw new Error(`Pinterest was still processing the video after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
}

export async function publish(record, post, deps = {}) {
  const { call = (method, path, body) => pinterest(record.accessToken, method, path, body), link = dropboxLink, upload = uploadVideo } = deps;
  const pin = pinFromPost(post);
  const board = await boardId(call, post.brand);
  if (pin.kind === "carousel") {
    const items = [];
    for (const path of pin.slidePaths) items.push({ url: await link(path), ...(pin.link ? { link: pin.link } : {}) });
    const created = await call("POST", "/pins", {
      board_id: board, title: pin.title, description: pin.description, media_source: { source_type: "multiple_image_urls", items, index: 0 }
    });
    if (!created.id) throw new Error("Pinterest returned no Pin id");
    return { pinId: created.id, url: `https://www.pinterest.com/pin/${created.id}/`, boardId: board };
  }
  const media_source = pin.kind === "video"
    // Cover = the frame one second in, so a fade-in from black never becomes the thumbnail.
    ? { source_type: "video_id", media_id: await upload(call, post.dropboxPath, post.filename, deps), cover_image_key_frame_time: 1 }
    : { source_type: "image_url", url: await link(post.dropboxPath) };
  const created = await call("POST", "/pins", {
    board_id: board, title: pin.title, description: pin.description, alt_text: pin.altText, ...(pin.link ? { link: pin.link } : {}), media_source
  });
  if (!created.id) throw new Error("Pinterest returned no Pin id");
  return { pinId: created.id, url: `https://www.pinterest.com/pin/${created.id}/`, boardId: board };
}

async function publishingTick() {
  const claimed = await api({ action: "claim-due-posts", destination: "pinterest", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const sent = await publish(await account(post.channelId), post);
      outcome = { externalPostId: sent.pinId, externalUrl: sent.url };
    } catch (error) {
      console.error("Scheduled Pinterest post failed:", post.id, error?.message);
      outcome = { error: error?.message || "Post failed" };
    }
    await api({ action: "finish-post", id: post.id, ...outcome });
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
      console.log("Pinterest tick", JSON.stringify(tick));
      return result(200, { ok: refresh.ok !== false, refresh, ...tick });
    } catch (error) {
      console.error("Pinterest tick failed:", error?.message);
      return result(502, { ok: false, refresh, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("Pinterest refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
