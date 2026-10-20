import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// TikTok worker for Elettro OS. Runs outside the VPC (it needs open.tiktokapis.com) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   the tick: renew access tokens that expire within
//                                             12 hours, then send approved TikTok posts whose time
//                                             has come (planner claim-due-posts / finish-post)
//   { action: "refresh" }                     renew tokens only, on demand
//   { action: "post", brand, dropboxPath, caption?, mode? }
//                                             send a Dropbox video to the brand's TikTok:
//                                             mode "draft" (default) lands in the creator's TikTok
//                                             inbox to finish in the app; "direct" posts it
//   { action: "status", brand, publishId }    where a post is in TikTok's pipeline
//   { action: "creator-info", brand }         the account's name, avatar and allowed settings,
//                                             fresh from TikTok, for the Review page's TikTok card
// TikTok access tokens last 24 hours; the 365-day refresh token renews them, and each refresh
// can hand back a new refresh token, so the whole token record is rewritten every time.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// Until TikTok audits the app, scheduled posts go to the creator's inbox as drafts; set
// TIKTOK_TICK_MODE=direct once the audit passes. Drafts are capped by TikTok, so one per tick.
const TICK_MODE = process.env.TIKTOK_TICK_MODE || "draft";
const POSTS_PER_TICK = 1;
const APP_SECRET = process.env.TIKTOK_OAUTH_SECRET_NAME || "elettro-brand-os-dev/tiktok-oauth";
const TOKEN_PREFIX = process.env.TIKTOK_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/tiktok/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const API = "https://open.tiktokapis.com/v2";
const TOKEN_URL = `${API}/oauth/token/`;
// Renew when less than this is left; with a 6-hour schedule every token gets two tries.
const RENEW_WITHIN_MS = 12 * 3600 * 1000;
// Until TikTok audits the app, direct posts can only be private: TIKTOK_PRIVACY=SELF_ONLY forces
// that over the reviewer's choice. Unset, posts use the privacy picked on the Review page.
const PRIVACY_OVERRIDE = process.env.TIKTOK_PRIVACY || "";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
const MB = 1024 * 1024;
// TikTok chunks: 5-64 MB each, the last one may run up to 128 MB; videos up to 64 MB go in one piece.
const CHUNK = 10 * MB;

const result = (statusCode, payload) => ({ statusCode, ...payload });

export function needsRefresh(record, now = new Date()) {
  const expires = Date.parse(record?.accessExpiresAt || "");
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

// Fallbacks match TikTok's documented lifetimes when a response leaves them out.
function at(now, seconds, fallback) {
  const s = Number(seconds);
  return new Date(now.getTime() + (Number.isFinite(s) && s > 0 ? s : fallback) * 1000).toISOString();
}

export async function refreshRecord(record, app, now = new Date(), post = fetch) {
  if (!record?.refreshToken) throw new Error("no refresh token stored");
  const response = await post(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: app.clientKey, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: record.refreshToken
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`TikTok refresh failed: ${body.error_description || body.error || response.status}`);
  }
  return {
    ...record,
    accessToken: body.access_token,
    accessExpiresAt: at(now, body.expires_in, 86_400),
    refreshToken: body.refresh_token || record.refreshToken,
    refreshExpiresAt: body.refresh_token ? at(now, body.refresh_expires_in, 31_536_000) : record.refreshExpiresAt,
    scope: body.scope || record.scope,
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

export async function refreshAll(now = new Date()) {
  const app = await secretJson(APP_SECRET);
  if (!app.clientKey || !app.clientSecret) throw new Error(`${APP_SECRET} needs "clientKey" and "clientSecret"`);
  const accounts = [];
  for (const SecretId of await tokenSecretNames()) {
    const record = await secretJson(SecretId);
    const handle = record.username ? "@" + record.username : record.openId;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, accessExpiresAt: record.accessExpiresAt }); continue; }
    try {
      const next = await refreshRecord(record, app, now);
      await secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(next) }));
      accounts.push({ handle, refreshed: true, accessExpiresAt: next.accessExpiresAt });
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("TikTok refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("TikTok refresh", JSON.stringify(summary));
  return summary;
}

// Validates a post request, or throws with a readable reason.
export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as stashbox");
  const dropboxPath = String(event.dropboxPath || "").replace(/\\/g, "/");
  if (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  }
  if (!/\.(mp4|mov|webm)$/i.test(dropboxPath)) throw new Error("dropboxPath must be an .mp4, .mov or .webm video");
  const caption = String(event.caption || "");
  if (caption.length > 2200) throw new Error("caption allows up to 2200 characters");
  const mode = event.mode || "draft";
  if (!["draft", "direct"].includes(mode)) throw new Error('mode must be "draft" or "direct"');
  return { brand, dropboxPath, caption, mode };
}

export function chunkPlan(size) {
  if (!Number.isFinite(size) || size <= 0) throw new Error("video is empty");
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  // The remainder rides on the last chunk, so it stays under 2 × CHUNK.
  return { chunkSize: CHUNK, count: Math.floor(size / CHUNK) };
}

// TikTok wraps every answer as { data, error: { code, message, log_id } }; code "ok" means success.
async function tiktok(path, accessToken, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000)
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || (out.error?.code && out.error.code !== "ok")) {
    throw new Error(`TikTok ${path} failed: ${out.error?.code || response.status}${out.error?.message ? " — " + out.error.message : ""}`);
  }
  return out.data || {};
}

// The token record for a brand (manual posts) or an open_id (planner posts), renewed first when
// it is close to expiring.
async function brandAccount(brand, openId) {
  const names = await tokenSecretNames();
  for (const SecretId of openId ? names.filter((n) => n === TOKEN_PREFIX + openId) : names) {
    let record = await secretJson(SecretId);
    if (!openId && record.brand !== brand) continue;
    if (needsRefresh(record)) {
      record = await refreshRecord(record, await secretJson(APP_SECRET));
      await secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) }));
    }
    return record;
  }
  throw new Error(`No TikTok account is connected for ${openId || brand}`);
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

async function sendChunks(uploadUrl, file, plan) {
  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.count - 1 ? file.size - 1 : start + plan.chunkSize - 1;
    const part = await fetch(file.link, { headers: { range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(300000) });
    const bytes = Buffer.from(await part.arrayBuffer());
    if (!part.ok || bytes.length !== end - start + 1) throw new Error(`Dropbox read failed at byte ${start} (HTTP ${part.status})`);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${file.size}` },
      body: bytes,
      signal: AbortSignal.timeout(300000)
    });
    if (!response.ok) throw new Error(`TikTok upload failed at byte ${start} (HTTP ${response.status}: ${(await response.text()).slice(0, 300)})`);
  }
}

// post_info for a direct post from the settings the creator picked on the Review page.
export function postInfo(settings, caption, override = PRIVACY_OVERRIDE) {
  if (!settings?.privacyLevel) throw new Error("No TikTok settings: approve this post from its TikTok card on the Review page");
  return {
    title: caption, privacy_level: override || settings.privacyLevel,
    disable_comment: settings.allowComment !== true, disable_duet: settings.allowDuet !== true, disable_stitch: settings.allowStitch !== true,
    brand_organic_toggle: settings.yourBrand === true, brand_content_toggle: settings.brandedContent === true
  };
}

const PRIVACY_LEVELS = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];

// A manual post: the TikTok card's choices from the Connections page ({ settings }), or for a bare
// console test a private post with interactions on.
export function manualSettings(event) {
  const s = event.settings && typeof event.settings === "object" ? event.settings : null;
  if (!s) return { privacyLevel: String(event.privacyLevel || "SELF_ONLY"), allowComment: true, allowDuet: true, allowStitch: true };
  if (!PRIVACY_LEVELS.includes(s.privacyLevel)) throw new Error("Choose who can view this TikTok post");
  const settings = {
    privacyLevel: s.privacyLevel, allowComment: s.allowComment === true, allowDuet: s.allowDuet === true, allowStitch: s.allowStitch === true,
    yourBrand: s.yourBrand === true, brandedContent: s.brandedContent === true
  };
  if (settings.brandedContent && settings.privacyLevel === "SELF_ONLY") throw new Error("Branded content can't be private");
  return settings;
}

async function creatorInfo(brand) {
  const account = await brandAccount(String(brand || ""));
  const c = await tiktok("/post/publish/creator_info/query/", account.accessToken);
  return {
    username: c.creator_username || account.username || null, nickname: c.creator_nickname || null, avatarUrl: c.creator_avatar_url || null,
    privacyLevelOptions: c.privacy_level_options || [], commentDisabled: c.comment_disabled === true,
    duetDisabled: c.duet_disabled === true, stitchDisabled: c.stitch_disabled === true, maxVideoPostDurationSec: c.max_video_post_duration_sec || null
  };
}

async function postVideo(request) {
  const [account, file] = await Promise.all([brandAccount(request.brand, request.openId), dropboxFile(request.dropboxPath)]);
  const plan = chunkPlan(file.size);
  const source_info = { source: "FILE_UPLOAD", video_size: file.size, chunk_size: plan.chunkSize, total_chunk_count: plan.count };
  let init;
  if (request.mode === "direct") {
    // TikTok requires a fresh creator_info query before every direct post.
    const creator = await tiktok("/post/publish/creator_info/query/", account.accessToken);
    const post_info = postInfo(request.settings, request.caption);
    if (!(creator.privacy_level_options || []).includes(post_info.privacy_level)) {
      throw new Error(`TikTok does not allow ${post_info.privacy_level} for ${account.username || account.openId} (options: ${(creator.privacy_level_options || []).join(", ")})`);
    }
    // Interactions the creator turned off in the TikTok app stay off.
    if (creator.comment_disabled) post_info.disable_comment = true;
    if (creator.duet_disabled) post_info.disable_duet = true;
    if (creator.stitch_disabled) post_info.disable_stitch = true;
    // TikTok's "AI-generated content" label, required for realistic AI-made video.
    if (request.aigc === true) post_info.is_aigc = true;
    init = await tiktok("/post/publish/video/init/", account.accessToken, { post_info, source_info });
  } else {
    init = await tiktok("/post/publish/inbox/video/init/", account.accessToken, { source_info });
  }
  await sendChunks(init.upload_url, file, plan);
  const status = await tiktok("/post/publish/status/fetch/", account.accessToken, { publish_id: init.publish_id }).catch((error) => ({ status: "UNKNOWN", error: error.message }));
  return {
    handle: account.username ? "@" + account.username : account.openId, mode: request.mode, file: file.name, bytes: file.size,
    publishId: init.publish_id, status: status.status, failReason: status.fail_reason || undefined
  };
}

async function postStatus(brand, publishId) {
  if (!/^[A-Za-z0-9_.~-]{4,200}$/.test(String(publishId || ""))) throw new Error("publishId is required");
  const account = await brandAccount(String(brand || ""));
  const status = await tiktok("/post/publish/status/fetch/", account.accessToken, { publish_id: publishId });
  return { publishId, status: status.status, failReason: status.fail_reason || undefined, postIds: status.publicaly_available_post_id || [] };
}

// A planner post as a post request: caption plus hashtags, TikTok's 2200-character limit.
export function requestFromPost(post, mode) {
  const tags = (post.hashtags || []).map((h) => String(h).replace(/^#/, "").trim()).filter(Boolean);
  const caption = [post.caption, tags.map((t) => `#${t}`).join(" ")].map((p) => String(p || "").trim()).filter(Boolean).join("\n\n");
  return {
    ...postRequest({ brand: "planner", dropboxPath: post.dropboxPath, caption: caption.slice(0, 2200), mode }),
    openId: String(post.channelId || ""), settings: post.tiktok || null, aigc: post.synthetic === true
  };
}

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

async function publishingTick() {
  const claimed = await api({ action: "claim-due-posts", destination: "tiktok", limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const sent = await postVideo(requestFromPost(post, TICK_MODE));
      // TikTok gives a publish_id at once; the public post id only exists after the creator
      // finishes a draft (or after a direct post is processed), so the ledger keeps the publish_id.
      outcome = { externalPostId: sent.publishId };
    } catch (error) {
      console.error("Scheduled TikTok post failed:", post.id, error?.message);
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
      console.log("TikTok tick", JSON.stringify(tick));
      return result(200, { ok: refresh.ok !== false, refresh, ...tick });
    } catch (error) {
      console.error("TikTok tick failed:", error?.message);
      return result(502, { ok: false, refresh, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("TikTok refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const posted = await postVideo({ ...request, settings: manualSettings(event) });
      console.log("TikTok post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("TikTok post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  if (event.action === "creator-info") {
    try { return result(200, { ok: true, ...(await creatorInfo(event.brand)) }); } catch (error) {
      return result(502, { ok: false, error: error?.message || "TikTok account lookup failed" });
    }
  }
  if (event.action === "status") {
    try { return result(200, { ok: true, ...(await postStatus(event.brand, event.publishId)) }); } catch (error) {
      return result(502, { ok: false, error: error?.message || "Status check failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
