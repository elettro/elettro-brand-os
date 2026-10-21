import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Threads worker for Elettro OS. Runs outside the VPC (it needs graph.threads.net) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   the tick: renew tokens with less than 30 days left,
//                                             then publish approved Threads posts whose time has
//                                             come (planner claim-due-posts / finish-post)
//   { action: "refresh" }                     renew tokens only, on demand
//   { action: "post", brand, text, dropboxPath? }
//                                             publish now to the brand's Threads: a text post, or
//                                             with a Dropbox image or video under the brands root
// Threads publishes in two steps: create a media container (Threads fetches the media from a
// short-lived Dropbox link), wait until it is FINISHED, then publish it.
// Threads has no refresh token: the 60-day access token renews itself (th_refresh_token) once it
// is at least 24 hours old and not yet expired, so a missed window means reconnecting by hand.
// After a renewal the dev API moves the account's reconnect countdown (set-token-expiry).

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the app secret (elettro-brand-os-dev/threads-oauth) out of the list.
const TOKEN_PREFIX = process.env.THREADS_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/threads/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const GRAPH = "https://graph.threads.net";
const REFRESH_URL = `${GRAPH}/refresh_access_token`;
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
// Threads rejects text over 500 characters and links one topic tag per post.
const MAX_TEXT = 500;
// One post per tick keeps a backlog from bursting onto the feed.
const POSTS_PER_TICK = 1;
// Video containers take a while to process; poll every 5 s for up to 4 minutes (Lambda timeout 5 min).
const POLL_MS = 5000;
const POLL_LIMIT_MS = 240_000;
// Checked every tick, so a token gets many tries in its last 30 days.
const RENEW_WITHIN_MS = 30 * 86_400_000;
// Threads refuses to renew a token younger than 24 hours.
const MIN_AGE_MS = 86_400_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

export function needsRefresh(record, now = new Date()) {
  const expires = Date.parse(record?.expiresAt || "");
  if (Number.isFinite(expires) && expires <= now.getTime()) return false;
  const issued = Date.parse(record?.refreshedAt || record?.connectedAt || "");
  if (Number.isFinite(issued) && now.getTime() - issued < MIN_AGE_MS) return false;
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

export async function refreshRecord(record, now = new Date(), get = fetch) {
  if (!record?.accessToken) throw new Error("no access token stored");
  const url = new URL(REFRESH_URL);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", record.accessToken);
  const response = await get(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`Threads refresh failed: ${body.error?.message || response.status}`);
  }
  const seconds = Number(body.expires_in);
  // Threads documents 60 days; fall back to that when the response leaves it out.
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 60 * 86_400;
  return {
    ...record,
    accessToken: body.access_token,
    expiresAt: new Date(now.getTime() + lifetime * 1000).toISOString(),
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
    secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) })), refresh = refreshRecord, callApi = api } = deps;
  const accounts = [];
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    const handle = record.username ? "@" + record.username : record.userId;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, expiresAt: record.expiresAt }); continue; }
    try {
      const next = await refresh(record, now);
      await write(SecretId, next);
      const entry = { handle, refreshed: true, expiresAt: next.expiresAt };
      // The token is safe once written; a stale countdown is only cosmetic, so report it and carry on.
      const moved = await callApi({ action: "set-token-expiry", destination: "threads", externalAccountId: record.userId, tokenExpiresAt: next.expiresAt })
        .catch((error) => ({ ok: false, error: error?.message }));
      if (!moved.ok) entry.countdownError = moved.error || "set-token-expiry failed";
      accounts.push(entry);
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("Threads refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("Threads refresh", JSON.stringify(summary));
  return summary;
}

// Validates a post request, or throws with a readable reason.
export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as stashbox");
  const text = String(event.text || "").trim();
  if (text.length > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const dropboxPath = event.dropboxPath ? String(event.dropboxPath).replace(/\\/g, "/") : null;
  if (!dropboxPath && !text) throw new Error("a post needs text, a Dropbox image or video, or both");
  if (dropboxPath && (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((p) => p === ".." || p === "."))) {
    throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  }
  const mediaType = !dropboxPath ? "TEXT" : /\.(mp4|mov)$/i.test(dropboxPath) ? "VIDEO" : /\.(jpe?g|png)$/i.test(dropboxPath) ? "IMAGE" : null;
  if (!mediaType) throw new Error("dropboxPath must be an .mp4 or .mov video or a .jpg or .png image");
  return { brand, text, dropboxPath, mediaType };
}

// Planner caption plus at most one hashtag (Threads makes it the post's topic), within 500 characters.
export function postText(caption, hashtags = []) {
  const tag = (hashtags || []).map((h) => String(h).replace(/^#/, "").trim()).find(Boolean);
  const body = String(caption || "").trim();
  const withTag = tag ? `${body}\n\n#${tag}`.trim() : body;
  return withTag.length <= MAX_TEXT ? withTag : body.slice(0, MAX_TEXT);
}

export function requestFromPost(post) {
  return { ...postRequest({ brand: "planner", text: postText(post.caption, post.hashtags), dropboxPath: post.dropboxPath }), userId: String(post.channelId || "") };
}

// The token record for a brand (manual posts) or a Threads user id (planner posts).
export async function account(brand, userId, deps = {}) {
  const { names = tokenSecretNames, read = secretJson, now = new Date() } = deps;
  for (const SecretId of await names()) {
    if (userId && SecretId !== TOKEN_PREFIX + userId) continue;
    const record = await read(SecretId);
    if (record.revokedAt || !record.accessToken || (!userId && record.brand !== brand)) continue;
    if (Date.parse(record.expiresAt || "") <= now.getTime()) {
      throw new Error(`The Threads login for ${record.username ? "@" + record.username : record.userId} has expired; reconnect it on /connections`);
    }
    return record;
  }
  throw new Error(`No Threads account is connected for ${userId || brand}`);
}

// Graph API call; Threads errors come back as { error: { message, code } }.
export async function threads(path, accessToken, { method = "GET", params = {} } = {}, call = fetch) {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  const response = method === "GET"
    ? await call(new URL(`${GRAPH}/v1.0/${path}?${query}`), { signal: AbortSignal.timeout(30000) })
    : await call(new URL(`${GRAPH}/v1.0/${path}`), { method, body: query, signal: AbortSignal.timeout(30000) });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || out.error) throw new Error(`Threads ${path.split("/").pop()} failed: ${out.error?.message || response.status}`);
  return out;
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

// A 4-hour public link Threads can fetch the media from.
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

// Create the container, wait for Threads to finish processing it, publish, then read the permalink.
export async function publish(record, request, deps = {}) {
  const { call = (path, opts) => threads(path, record.accessToken, opts), link = dropboxLink, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  const params = { media_type: request.mediaType, ...(request.text ? { text: request.text } : {}) };
  if (request.mediaType === "VIDEO") params.video_url = await link(request.dropboxPath);
  if (request.mediaType === "IMAGE") params.image_url = await link(request.dropboxPath);
  const container = await call(`${record.userId}/threads`, { method: "POST", params });
  if (!container.id) throw new Error("Threads returned no media container");
  for (let waited = 0; ; waited += pollMs) {
    const state = await call(container.id, { params: { fields: "status,error_message" } });
    if (state.status === "FINISHED") break;
    if (state.status === "ERROR" || state.status === "EXPIRED") throw new Error(`Threads could not process the media: ${state.error_message || state.status}`);
    if (waited >= limitMs) throw new Error(`Threads was still processing the media after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
  const published = await call(`${record.userId}/threads_publish`, { method: "POST", params: { creation_id: container.id } });
  if (!published.id) throw new Error("Threads returned no post id");
  // The post is live at this point; a missing permalink only leaves the ledger without a link.
  const permalink = await call(published.id, { params: { fields: "permalink" } }).then((r) => r.permalink || null, () => null);
  return { postId: published.id, permalink, handle: record.username ? "@" + record.username : record.userId };
}

async function publishingTick() {
  const claimed = await api({ action: "claim-due-posts", destination: "threads", limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const sent = await publish(await account(null, request.userId), request);
      outcome = { externalPostId: sent.postId, ...(sent.permalink ? { externalUrl: sent.permalink } : {}) };
    } catch (error) {
      console.error("Scheduled Threads post failed:", post.id, error?.message);
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
      console.log("Threads tick", JSON.stringify(tick));
      return result(200, { ok: refresh.ok !== false, refresh, ...tick });
    } catch (error) {
      console.error("Threads tick failed:", error?.message);
      return result(502, { ok: false, refresh, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("Threads refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const posted = await publish(await account(request.brand), request);
      console.log("Threads post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("Threads post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
