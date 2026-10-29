import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Bluesky worker for Elettro OS. Runs outside the VPC (it needs bsky.social and the PDS hosts) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   the tick: keep idle logins alive, then publish approved Bluesky posts whose
//                                             time has come (planner claim-due-posts / finish-post)
//   { action: "refresh" }                     keep every login alive now
//   { action: "post", brand, text, dropboxPaths? | dropboxPath? }
//                                             publish now: text only, 1-4 Dropbox images, or one Dropbox video
//
// Bluesky post shapes (app.bsky.feed.post): text up to 300 graphemes with link/#tag "facets" (UTF-8 byte ranges),
// and at most one embed: 1-4 images (each blob under ~1 MB, so images are re-encoded here) OR one video (uploaded
// through Bluesky's video service, up to 3 minutes). Placements published: post (1 image), carousel (2-4 images), video.
//
// Auth is AT Protocol OAuth (confidential client, DPoP). Each account's saved session lives in Secrets Manager
// (elettro-brand-os-dev/bluesky/<did with : as _>, written by the dev-api's /connections/bluesky/complete). The OAuth
// library refreshes the access token on demand and the refresh token ROTATES, so every refresh is written straight
// back to the same secret (the sessionStore below). After a refresh the dev API moves the account's reconnect
// countdown (set-token-expiry).

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the signing-key secret (elettro-brand-os-dev/bluesky-oauth) out of the list.
const TOKEN_PREFIX = process.env.BLUESKY_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/bluesky/";
const OAUTH_SECRET = process.env.BLUESKY_OAUTH_SECRET || "elettro-brand-os-dev/bluesky-oauth";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const ORIGIN = "https://os.elettro.com";
const CLIENT_ID = `${ORIGIN}/api/connections/bluesky/client-metadata`;
const VIDEO_SERVICE = "https://video.bsky.app";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
export const MAX_TEXT = 300; // graphemes
export const MAX_IMAGES = 4;
export const IMAGE_BYTE_LIMIT = 950_000; // Bluesky refuses image blobs over 1,000,000 bytes
export const VIDEO_BYTE_LIMIT = 100 * 1024 * 1024;
const REFRESH_WINDOW_MS = 180 * 86_400_000; // confidential-client refresh tokens last up to about 180 days
const KEEP_ALIVE_MS = 7 * 86_400_000; // an idle login is used at least this often
const PLACEMENTS = ["post", "carousel", "video"];
const POSTS_PER_TICK = 1;
const POLL_MS = 3000;
const POLL_LIMIT_MS = 240_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

// ---------- text ----------

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export const graphemeLength = (text) => [...segmenter.segment(String(text))].length;
function truncateGraphemes(text, max) {
  const parts = [...segmenter.segment(String(text))].map((s) => s.segment);
  return parts.length <= max ? text : parts.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Planner caption plus at most one hashtag, within 300 graphemes (the caption is cut, never the tag). */
export function postText(caption, hashtags = []) {
  const tag = (hashtags || []).map((h) => String(h).replace(/^#/, "").replace(/\s+/g, "").trim()).find(Boolean);
  const body = String(caption || "").trim();
  if (!tag) return truncateGraphemes(body, MAX_TEXT);
  const suffix = `\n\n#${tag}`;
  if (graphemeLength(suffix) >= MAX_TEXT) return truncateGraphemes(body, MAX_TEXT);
  return (truncateGraphemes(body, MAX_TEXT - graphemeLength(suffix)) + suffix).trim();
}

/**
 * Links and #tags become clickable through "facets": byte ranges (UTF-8) of the text. Mentions are not linked
 * (that needs a handle lookup); an @name stays plain text.
 */
export function facetsFor(text) {
  const encoder = new TextEncoder();
  const byteStart = (charIndex) => encoder.encode(text.slice(0, charIndex)).length;
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    // Trailing sentence punctuation is not part of the link.
    const uri = m[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(uri)) continue;
    const start = byteStart(m.index);
    facets.push({ index: { byteStart: start, byteEnd: start + encoder.encode(uri).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri }] });
  }
  for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/gu)) {
    const tag = m[2].slice(1);
    if (graphemeLength(tag) > 64) continue;
    const start = byteStart(m.index + m[1].length);
    facets.push({ index: { byteStart: start, byteEnd: start + encoder.encode(m[2]).length }, features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// ---------- requests ----------

const safePath = (value) => {
  const path = String(value || "").replace(/\\/g, "/");
  if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  return path;
};
const IMAGE = /\.(jpe?g|png|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v)$/i;

// A manual post: text, 1-4 images, or one video.
export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as stashbox");
  const text = String(event.text || "").trim();
  if (graphemeLength(text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const paths = (Array.isArray(event.dropboxPaths) ? event.dropboxPaths : event.dropboxPath ? [event.dropboxPath] : []).map(safePath);
  if (!paths.length && !text) throw new Error("a post needs text, Dropbox images, a Dropbox video, or both");
  if (paths.length > MAX_IMAGES) throw new Error(`a Bluesky post holds up to ${MAX_IMAGES} images`);
  if (!paths.length) return { brand, text, kind: "text", paths };
  if (paths.every((p) => IMAGE.test(p))) return { brand, text, kind: "images", paths };
  if (paths.length === 1 && VIDEO.test(paths[0])) return { brand, text, kind: "video", paths };
  throw new Error("use up to 4 .jpg/.png/.webp images, or exactly one .mp4/.mov video (not both)");
}

export function requestFromPost(post) {
  const text = postText(post.caption, post.hashtags);
  const userId = String(post.channelId || "");
  const alt = String(post.altText || post.caption || post.title || "").trim().slice(0, 1000);
  if (post.placement === "carousel") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < 2 || slides.length > MAX_IMAGES) throw new Error(`a Bluesky multi-photo post needs 2-${MAX_IMAGES} images; this one has ${slides.length}`);
    const paths = slides.map((s) => safePath(s.dropboxPath));
    if (!paths.every((p) => IMAGE.test(p))) throw new Error("every slide must be a .jpg, .png or .webp image");
    return { brand: "planner", text, kind: "images", paths, alt, userId };
  }
  if (post.placement === "video") {
    const path = safePath(post.dropboxPath);
    if (!VIDEO.test(path)) throw new Error("a Bluesky video must be an .mp4, .mov or .m4v file");
    return { brand: "planner", text, kind: "video", paths: [path], alt, userId };
  }
  const path = safePath(post.dropboxPath);
  if (!IMAGE.test(path)) throw new Error("a Bluesky photo post needs a .jpg, .png or .webp image");
  return { brand: "planner", text, kind: "images", paths: [path], alt, userId };
}

// ---------- Secrets Manager + session store ----------

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

export const secretNameFor = (did) => TOKEN_PREFIX + String(did).replace(/:/g, "_");

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

/** A NodeSavedSessionStore whose storage is the account's secret; see oauthClient. */
export function secretSessionStore({ readSecret, writeSecret, now, changed }) {
  return {
    async get(did) {
      const record = await readSecret(secretNameFor(did)).catch(() => null);
      return record?.session;
    },
    async set(did, session) {
      const SecretId = secretNameFor(did);
      const record = await readSecret(SecretId).catch(() => ({}));
      const at = now();
      await writeSecret(SecretId, { ...record, did, session, refreshedAt: at.toISOString(), expiresAt: new Date(at.getTime() + REFRESH_WINDOW_MS).toISOString() });
      changed.add(did);
    },
    async del(did) {
      const SecretId = secretNameFor(did);
      const record = await readSecret(SecretId).catch(() => null);
      // Revoked or rejected: keep the record (so the account shows as needing a reconnect) but drop the dead session.
      if (record) await writeSecret(SecretId, { ...record, session: undefined, revokedAt: now().toISOString() });
    }
  };
}

/**
 * The OAuth client for this Lambda. Its sessionStore IS the account's secret: restoring reads it, and every token
 * refresh (the refresh token rotates) writes the new session back, recording `refreshedAt`/`expiresAt` and noting
 * the did in `changed` so the tick can move the reconnect countdown.
 */
export async function oauthClient(deps = {}) {
  const { readSecret = secretJson, writeSecret = (SecretId, record) =>
    secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) })), now = () => new Date() } = deps;
  const { NodeOAuthClient } = await import("@atproto/oauth-client-node");
  const { JoseKey } = await import("@atproto/jwk-jose");
  const { privateJwk } = await readSecret(OAUTH_SECRET);
  if (!privateJwk) throw new Error(`${OAUTH_SECRET} needs a "privateJwk" key`);
  const changed = new Set();
  const locks = new Map();
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: CLIENT_ID, client_name: "Elettro OS", client_uri: ORIGIN,
      redirect_uris: [`${ORIGIN}/api/connections/bluesky/callback`],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "atproto transition:generic",
      token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256", application_type: "web",
      dpop_bound_access_tokens: true, jwks_uri: `${ORIGIN}/api/connections/bluesky/jwks`
    },
    keyset: [await JoseKey.fromImportable(typeof privateJwk === "string" ? privateJwk : JSON.stringify(privateJwk))],
    // In-process queue per account: one Lambda instance never refreshes the same login twice at once.
    requestLock: async (name, fn) => {
      const previous = locks.get(name) || Promise.resolve();
      const run = previous.catch(() => {}).then(fn);
      locks.set(name, run);
      try { return await run; } finally { if (locks.get(name) === run) locks.delete(name); }
    },
    stateStore: { get: async () => undefined, set: async () => {}, del: async () => {} },
    sessionStore: secretSessionStore({ readSecret, writeSecret, now, changed })
  });
  return { client, changed };
}

// ---------- images, video, Dropbox ----------

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

/** Re-encode to a JPEG under Bluesky's blob limit, longest edge 2000 px, stepping quality (then size) down. */
export async function prepareImage(input, deps = {}) {
  const sharp = deps.sharp || (await import("sharp")).default;
  let edge = 2000;
  for (let quality = 88; ; quality -= 8) {
    const out = await sharp(input).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (out.data.length <= IMAGE_BYTE_LIMIT) return { bytes: out.data, mime: "image/jpeg", width: out.info.width, height: out.info.height };
    if (quality <= 48) { edge = Math.round(edge * 0.75); quality = 96; }
    if (edge < 600) throw new Error("This image cannot be made small enough for Bluesky");
  }
}

// ---------- publishing ----------

export const postUrl = (handle, uri) => `https://bsky.app/profile/${String(handle).replace(/^@/, "")}/post/${String(uri).split("/").pop()}`;

async function xrpc(session, method, nsid, { params, body, headers } = {}) {
  const query = params ? "?" + new URLSearchParams(params) : "";
  const init = { method, headers: { ...(headers || {}) }, signal: AbortSignal.timeout(60000) };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) init.body = body;
    else { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  }
  const response = await session.fetchHandler(`/xrpc/${nsid}${query}`, init);
  const out = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Bluesky ${nsid.split(".").pop()} failed: ${out.message || out.error || response.status}`);
  return out;
}

async function uploadVideo(session, record, bytes, name, deps) {
  const { fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  if (bytes.length > VIDEO_BYTE_LIMIT) throw new Error("Bluesky videos can be up to 100 MB");
  // The video service authenticates with a short-lived token the user's PDS signs for it.
  const aud = `did:web:${new URL(record.pds).host}`;
  const auth = await xrpc(session, "GET", "com.atproto.server.getServiceAuth", {
    params: { aud, lxm: "com.atproto.repo.uploadBlob", exp: String(Math.floor(Date.now() / 1000) + 30 * 60) }
  });
  const upload = await fetchImpl(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo?${new URLSearchParams({ did: record.did, name })}`, {
    method: "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "video/mp4" }, body: bytes, signal: AbortSignal.timeout(180000)
  });
  const started = await upload.json().catch(() => ({}));
  // 409 already_exists still names the job to follow.
  const jobId = started.jobId || started.jobStatus?.jobId;
  if (!jobId) throw new Error(`Bluesky video upload failed: ${started.message || started.error || upload.status}`);
  for (let waited = 0; ; waited += pollMs) {
    const poll = await fetchImpl(`${VIDEO_SERVICE}/xrpc/app.bsky.video.getJobStatus?${new URLSearchParams({ jobId })}`, { signal: AbortSignal.timeout(30000) });
    const status = (await poll.json().catch(() => ({}))).jobStatus || {};
    if (status.blob) return status.blob;
    if (status.state === "JOB_STATE_FAILED") throw new Error(`Bluesky could not process the video: ${status.error || status.message || "failed"}`);
    if (waited >= limitMs) throw new Error(`Bluesky was still processing the video after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
}

/** Upload the media, then create the post record. Returns the post's at:// uri and its bsky.app URL. */
export async function publish(session, record, request, deps = {}) {
  const { download = dropboxBytes, prepare = prepareImage } = deps;
  const text = request.text;
  if (graphemeLength(text) > MAX_TEXT) throw new Error(`text allows up to ${MAX_TEXT} characters`);
  const post = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString() };
  const facets = facetsFor(text);
  if (facets.length) post.facets = facets;
  if (request.kind === "images") {
    const images = [];
    for (const path of request.paths) {
      const img = await prepare(await download(path));
      const { blob } = await xrpc(session, "POST", "com.atproto.repo.uploadBlob", { body: img.bytes, headers: { "content-type": img.mime } });
      images.push({ image: blob, alt: request.alt || "", aspectRatio: { width: img.width, height: img.height } });
    }
    post.embed = { $type: "app.bsky.embed.images", images };
  } else if (request.kind === "video") {
    const path = request.paths[0];
    const blob = await uploadVideo(session, record, await download(path), path.split("/").pop(), deps);
    post.embed = { $type: "app.bsky.embed.video", video: blob, ...(request.alt ? { alt: request.alt } : {}) };
  }
  const created = await xrpc(session, "POST", "com.atproto.repo.createRecord", {
    body: { repo: record.did, collection: "app.bsky.feed.post", record: post }
  });
  if (!created.uri) throw new Error("Bluesky returned no post uri");
  return { uri: created.uri, url: postUrl(record.handle || record.did, created.uri), handle: record.handle || record.did };
}

// The stored record for a brand (manual posts) or a did (planner posts).
export async function account(brand, did, deps = {}) {
  const { names = tokenSecretNames, read = secretJson, now = new Date() } = deps;
  for (const SecretId of await names()) {
    if (did && SecretId !== secretNameFor(did)) continue;
    const record = await read(SecretId);
    if (record.revokedAt || !record.session || (!did && record.brand !== brand)) continue;
    if (Date.parse(record.expiresAt || "") <= now.getTime()) {
      throw new Error(`The Bluesky login for ${record.handle || record.did} has expired; reconnect it on /connections`);
    }
    return record;
  }
  throw new Error(`No Bluesky account is connected for ${did || brand}`);
}

async function restoreSession(client, record) {
  try {
    return await client.restore(record.did);
  } catch (error) {
    throw new Error(`The Bluesky login for ${record.handle || record.did} was rejected (${error?.message || "restore failed"}); reconnect it on /connections`);
  }
}

// Moves the reconnect countdown for every login whose token the library just rotated.
export async function moveCountdowns(changed, callApi = api, read = secretJson) {
  const moved = [];
  for (const did of changed) {
    const record = await read(secretNameFor(did)).catch(() => null);
    if (!record?.expiresAt) continue;
    const out = await callApi({ action: "set-token-expiry", destination: "bluesky", externalAccountId: did, tokenExpiresAt: record.expiresAt })
      .catch((error) => ({ ok: false, error: error?.message }));
    moved.push({ did, ok: Boolean(out.ok), ...(out.ok ? {} : { error: out.error || "set-token-expiry failed" }) });
  }
  return moved;
}

/** Use every idle login at least weekly so its rotating refresh token never lapses. */
export async function keepAlive(now = new Date(), deps = {}) {
  const { names = tokenSecretNames, read = secretJson, getClient = oauthClient, callApi = api } = deps;
  const accounts = [];
  const { client, changed } = await getClient();
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    const label = record.handle || record.did;
    if (record.revokedAt || !record.session) { accounts.push({ handle: label, refreshed: false, error: "needs reconnect" }); continue; }
    const issued = Date.parse(record.refreshedAt || record.connectedAt || "");
    if (Number.isFinite(issued) && now.getTime() - issued < KEEP_ALIVE_MS) { accounts.push({ handle: label, refreshed: false, expiresAt: record.expiresAt }); continue; }
    try {
      await client.restore(record.did, true);
      accounts.push({ handle: label, refreshed: true });
    } catch (error) {
      console.error("Bluesky keep-alive failed:", label, error?.message);
      accounts.push({ handle: label, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const countdown = await moveCountdowns(changed, callApi, read);
  const summary = { ok: accounts.every((a) => !a.error), accounts, countdown };
  console.log("Bluesky keep-alive", JSON.stringify(summary));
  return summary;
}

export async function publishingTick(deps = {}) {
  const { callApi = api, getClient = oauthClient, find = account, send = publish, countdowns = moveCountdowns } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "bluesky", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  let oauth;
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const record = await find(null, request.userId);
      oauth ||= await getClient();
      const sent = await send(await restoreSession(oauth.client, record), record, request);
      outcome = { externalPostId: sent.uri, externalUrl: sent.url };
    } catch (error) {
      console.error("Scheduled Bluesky post failed:", post.id, error?.message);
      outcome = { error: error?.message || "Post failed" };
    }
    await callApi({ action: "finish-post", id: post.id, ...outcome });
    published.push({ id: post.id, ...outcome });
  }
  if (oauth) await countdowns(oauth.changed, callApi);
  return { missed: claimed.missed, stuck: claimed.stuck, published };
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick") {
    // Logins first, so a post never goes out on a lapsed one; a keep-alive failure doesn't stop posting.
    const refresh = await keepAlive().catch((error) => ({ ok: false, error: error?.message }));
    try {
      const tick = await publishingTick();
      console.log("Bluesky tick", JSON.stringify(tick));
      return result(200, { ok: refresh.ok !== false, refresh, ...tick });
    } catch (error) {
      console.error("Bluesky tick failed:", error?.message);
      return result(502, { ok: false, refresh, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "refresh") {
    try { return result(200, await keepAlive(new Date(Date.now() + KEEP_ALIVE_MS))); } catch (error) {
      console.error("Bluesky refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const record = await account(request.brand);
      const { client, changed } = await oauthClient();
      const posted = await publish(await restoreSession(client, record), record, { ...request, alt: String(event.alt || "") });
      await moveCountdowns(changed);
      console.log("Bluesky post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("Bluesky post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
