import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Meta (Facebook Page + Instagram) publishing worker for Elettro OS. Runs outside the VPC (it needs
// graph.facebook.com) and is only invoked directly through IAM: no HTTP route points at it. Way in:
//   an EventBridge schedule (every 15 min)   the tick: for Instagram, then Facebook, claim the next due
//                                             approved planner post (claim-due-posts) -> publish -> finish-post
// Reels, feed posts and Stories (placement "reel" / "post" / "story") are claimed. Stories are
// published without a caption (neither network's Story API takes one).
// Page tokens come from "Connect Meta" (elettro-brand-os-dev/meta/<pageId>) and don't expire, so
// there is no renewal step. Media goes up by URL: a 4-hour Dropbox temporary link Meta downloads itself.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the app secret (elettro-brand-os-dev/meta-oauth) out of the list.
const TOKEN_PREFIX = process.env.META_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/meta/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const REEL_UPLOAD = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
const DESTINATIONS = ["instagram", "facebook"];
const PLACEMENTS = ["reel", "post", "story"];
// One post per network per tick keeps a backlog from bursting onto the feed.
const POSTS_PER_TICK = 1;
// Reels take a while to process; poll every 5 s for up to 5 minutes (Lambda timeout 15 min).
const POLL_MS = 5000;
const POLL_LIMIT_MS = 300_000;
const CAPTION_MAX = { instagram: 2200, facebook: 5000 };
const MAX_HASHTAGS = 30;

const result = (statusCode, payload) => ({ statusCode, ...payload });

// Planner caption plus its hashtags, within the network's caption limit.
export function captionFor(destination, post) {
  const max = CAPTION_MAX[destination];
  const body = String(post.caption || "").trim();
  if (!body) throw new Error("the planned post has no caption");
  const seen = new Set();
  const tags = (post.hashtags || [])
    .map((h) => String(h).replace(/^#+/, "").replace(/\s+/g, ""))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_HASHTAGS);
  const withTags = tags.length ? `${body}\n\n${tags.map((t) => "#" + t).join(" ")}` : body;
  return withTags.length <= max ? withTags : body.slice(0, max);
}

// Validates a claimed post for its network and placement, or throws with a readable reason.
export function publishRequest(destination, post) {
  const placement = String(post.placement || "");
  if (!PLACEMENTS.includes(placement)) throw new Error(`${destination} ${placement || "unknown"} posts aren't published automatically yet`);
  const dropboxPath = String(post.dropboxPath || "").replace(/\\/g, "/");
  if (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((p) => p === ".." || p === ".")) {
    throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  }
  const kind = /\.(mp4|mov)$/i.test(dropboxPath) ? "video" : /\.(jpe?g|png)$/i.test(dropboxPath) ? "image" : null;
  if (!kind) throw new Error("the clip must be an .mp4 or .mov video or a .jpg or .png image");
  if (placement === "reel" && kind !== "video") throw new Error(`a ${destination} Reel needs a video`);
  if (destination === "instagram" && placement === "post" && !(kind === "image" && /\.jpe?g$/i.test(dropboxPath))) {
    throw new Error("Instagram feed posts take JPEG photos only; pick a .jpg");
  }
  if (destination === "instagram" && placement === "story" && kind === "image" && !/\.jpe?g$/i.test(dropboxPath)) {
    throw new Error("Instagram Stories take JPEG photos only; pick a .jpg");
  }
  // Stories carry no caption, so a Story without one is fine.
  const caption = placement === "story" ? "" : captionFor(destination, post);
  return { destination, placement, kind, dropboxPath, caption, channelId: String(post.channelId || "") };
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

// The Page token record for a claimed post: its channelId is the Page id (facebook) or the
// Instagram business account id (instagram).
export async function tokenRecord(destination, channelId, deps = {}) {
  const { names = tokenSecretNames, read = secretJson } = deps;
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    if (record.revokedAt || !record.pageAccessToken) continue;
    const id = destination === "facebook" ? record.pageId : record.instagramId;
    if (id && String(id) === channelId) return record;
  }
  throw new Error(`No ${destination} login is connected for ${channelId || "this brand"}; connect it on /connections`);
}

// Graph API call; Meta errors come back as { error: { message, error_user_msg } }.
export async function graph(method, path, params, accessToken, what, call = fetch) {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  const response = method === "GET"
    ? await call(`${GRAPH}/${path}?${query}`, { signal: AbortSignal.timeout(30000) })
    : await call(`${GRAPH}/${path}`, { method, body: query, signal: AbortSignal.timeout(30000) });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || out.error) throw new Error(`Meta ${what} failed: ${out.error?.error_user_msg || out.error?.message || response.status}`);
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

// A 4-hour public link Meta can fetch the media from.
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

// Every post is disclosed as AI-generated (Dean 261025). Meta's flag: Instagram takes is_ai_generated on the media
// container, Facebook Reels and video Stories take it on the finish call. Facebook photos and feed videos have no
// documented flag, so they are left alone. A request can opt out with aiGenerated: false.
const aiLabel = (request) => (request.aiGenerated === false ? {} : { is_ai_generated: "true" });

// Instagram is create a container, wait for Meta to fetch and process it, then publish it.
export async function publishInstagram(record, request, deps = {}) {
  const { call = (method, path, params, what) => graph(method, path, params, record.pageAccessToken, what), link = dropboxLink,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  if (!record.instagramId) throw new Error("No Instagram account is linked to this Page");
  const url = await link(request.dropboxPath);
  const media = request.kind === "image" ? { image_url: url } : { video_url: url };
  const params = request.placement === "story"
    ? { media_type: "STORIES", ...media }
    : request.kind === "image"
      ? { image_url: url, caption: request.caption }
      : { media_type: "REELS", video_url: url, caption: request.caption, share_to_feed: "true" };
  const container = await call("POST", `${record.instagramId}/media`, { ...params, ...aiLabel(request) }, "Instagram upload");
  if (!container.id) throw new Error("Instagram returned no media container");
  for (let waited = 0; ; waited += pollMs) {
    const state = await call("GET", container.id, { fields: "status_code,status" }, "Instagram status");
    if (state.status_code === "FINISHED") break;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
      throw new Error(`Instagram could not process the media: ${state.status || state.status_code}`);
    }
    if (waited >= limitMs) throw new Error(`Instagram was still processing the media after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
  const published = await call("POST", `${record.instagramId}/media_publish`, { creation_id: container.id }, "Instagram publish");
  if (!published.id) throw new Error("Instagram returned no post id");
  // The post is live at this point; a missing permalink only leaves the ledger without a link.
  const permalink = await call("GET", published.id, { fields: "permalink" }, "Instagram link").then((r) => r.permalink || null, () => null);
  return { postId: published.id, permalink };
}

// Facebook Page Story. A photo is uploaded unpublished, then turned into a Story. A video is
// start -> Meta pulls the file from the link -> finish (it publishes as a Story on finish).
async function publishFacebookStory(record, request, url, { call, upload }) {
  const storiesLink = `https://www.facebook.com/stories/${record.pageId}`;
  if (request.kind === "image") {
    const photo = await call("POST", `${record.pageId}/photos`, { url, published: "false" }, "Facebook Story photo");
    if (!photo.id) throw new Error("Facebook returned no photo id");
    const story = await call("POST", `${record.pageId}/photo_stories`, { photo_id: photo.id }, "Facebook Story publish");
    return { postId: story.post_id || photo.id, permalink: storiesLink };
  }
  const start = await call("POST", `${record.pageId}/video_stories`, { upload_phase: "start" }, "Facebook Story start");
  if (!start.video_id) throw new Error("Facebook returned no Story video id");
  const sent = await upload(start.upload_url || `${REEL_UPLOAD}/${start.video_id}`, {
    method: "POST", headers: { authorization: `OAuth ${record.pageAccessToken}`, file_url: url }, signal: AbortSignal.timeout(60000)
  });
  const uploaded = await sent.json().catch(() => ({}));
  if (!sent.ok || !uploaded.success) throw new Error(`Meta Facebook Story upload failed: ${uploaded.debug_info?.message || sent.status}`);
  const done = await call("POST", `${record.pageId}/video_stories`, { upload_phase: "finish", video_id: start.video_id, ...aiLabel(request) }, "Facebook Story publish");
  return { postId: done.post_id || start.video_id, permalink: storiesLink };
}

// Facebook Page: photos and wide videos post in one call; a Reel is start -> Meta pulls the file
// from the link -> finish with PUBLISHED.
export async function publishFacebook(record, request, deps = {}) {
  const { call = (method, path, params, what) => graph(method, path, params, record.pageAccessToken, what), link = dropboxLink,
    upload = fetch } = deps;
  if (!record.pageId) throw new Error("No Facebook Page is connected");
  const url = await link(request.dropboxPath);
  if (request.placement === "story") return publishFacebookStory(record, request, url, { call, upload });
  if (request.kind === "image") {
    const photo = await call("POST", `${record.pageId}/photos`, { url, message: request.caption, published: "true" }, "Facebook photo");
    const id = photo.post_id || photo.id;
    if (!id) throw new Error("Facebook returned no post id");
    return { postId: id, permalink: `https://www.facebook.com/${id}` };
  }
  if (request.placement === "post") {
    const video = await call("POST", `${record.pageId}/videos`, { file_url: url, description: request.caption }, "Facebook video");
    if (!video.id) throw new Error("Facebook returned no video id");
    return { postId: video.id, permalink: `https://www.facebook.com/${record.pageId}/videos/${video.id}` };
  }
  const start = await call("POST", `${record.pageId}/video_reels`, { upload_phase: "start" }, "Facebook Reel start");
  if (!start.video_id) throw new Error("Facebook returned no Reel id");
  const sent = await upload(`${REEL_UPLOAD}/${start.video_id}`, {
    method: "POST", headers: { authorization: `OAuth ${record.pageAccessToken}`, file_url: url }, signal: AbortSignal.timeout(60000)
  });
  const uploaded = await sent.json().catch(() => ({}));
  if (!sent.ok || !uploaded.success) throw new Error(`Meta Facebook Reel upload failed: ${uploaded.debug_info?.message || sent.status}`);
  await call("POST", `${record.pageId}/video_reels`,
    { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: request.caption, ...aiLabel(request) }, "Facebook Reel publish");
  return { postId: start.video_id, permalink: `https://www.facebook.com/reel/${start.video_id}` };
}

async function publishPost(destination, post) {
  const request = publishRequest(destination, post);
  const record = await tokenRecord(destination, request.channelId);
  return destination === "instagram" ? publishInstagram(record, request) : publishFacebook(record, request);
}

export async function publishingTick(deps = {}) {
  const { callApi = api, publish = publishPost } = deps;
  const tick = { missed: 0, stuck: 0, published: [], errors: [] };
  // A failure on one network must not stop the other.
  for (const destination of DESTINATIONS) {
    try {
      const claimed = await callApi({ action: "claim-due-posts", destination, placements: PLACEMENTS, limit: POSTS_PER_TICK });
      if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
      tick.missed += claimed.missed || 0;
      tick.stuck += claimed.stuck || 0;
      for (const post of claimed.posts) {
        let outcome;
        try {
          const sent = await publish(destination, post);
          outcome = { externalPostId: sent.postId, ...(sent.permalink ? { externalUrl: sent.permalink } : {}) };
        } catch (error) {
          console.error(`Scheduled ${destination} post failed:`, post.id, error?.message);
          outcome = { error: error?.message || "Post failed" };
        }
        await callApi({ action: "finish-post", id: post.id, ...outcome });
        tick.published.push({ id: post.id, destination, ...outcome });
      }
    } catch (error) {
      console.error(`Meta ${destination} tick failed:`, error?.message);
      tick.errors.push(`${destination}: ${error?.message || "Tick failed"}`);
    }
  }
  return tick;
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick") {
    const tick = await publishingTick();
    console.log("Meta tick", JSON.stringify(tick));
    return result(tick.errors.length ? 502 : 200, { ok: !tick.errors.length, ...tick });
  }
  return result(400, { ok: false, error: "Unknown action" });
}
