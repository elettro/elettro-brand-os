import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { META_GRAPH_VERSION } from "@/lib/meta-connect";
import { reviewCall } from "@/lib/planner-review";

// Server only. Facebook Page + Instagram publishing with the Page token from "Connect Meta".
// Media goes up by URL: a 4-hour Dropbox temporary link that Meta downloads itself.
const secrets = new SecretsManagerClient({ region: "us-east-1" });
const TOKEN_PREFIX = "elettro-brand-os-dev/meta/";
const graph = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export type PageToken = { pageAccessToken: string; pageId: string; pageName: string; instagramId: string | null; instagramUsername: string | null; brand: string };
export type LibraryAsset = { id: string; filename: string; kind: string; sourcePath: string; title: string | null; aspectRatioLabel: string | null; durationMs: number | null; mimeType: string | null };

export class PublishError extends Error {}

export async function brandPageToken(brand: string): Promise<PageToken> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as PageToken;
    if (token.brand === brand && token.pageAccessToken) return token;
  }
  throw new PublishError("Connect Facebook + Instagram for this brand first");
}

export async function brandAsset(brand: string, id: string): Promise<LibraryAsset> {
  const { data } = await reviewCall<{ ok: boolean; error?: string; asset?: LibraryAsset }>({ brand, action: "asset", id });
  if (!data.ok || !data.asset?.sourcePath) throw new PublishError(data.error || "That asset is not in the approved library");
  return data.asset;
}

async function dropboxToken() {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/dropbox" }));
  const cfg = JSON.parse(secret.SecretString || "{}") as Record<string, string>;
  const refresh = cfg.refresh_token || cfg.refreshToken, key = cfg.app_key || cfg.appKey, password = cfg.app_secret || cfg.appSecret;
  if (!refresh || !key || !password) throw new PublishError("Dropbox connection unavailable");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key, client_secret: password }), cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string };
  if (!response.ok || !token.access_token) throw new PublishError("Dropbox authorization failed");
  return token.access_token;
}

export async function mediaLink(sourcePath: string) {
  const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST", headers: { authorization: "Bearer " + await dropboxToken(), "content-type": "application/json" },
    body: JSON.stringify({ path: sourcePath }), cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as { link?: string };
  if (!response.ok || !body.link) throw new PublishError("Dropbox could not share that file");
  return body.link;
}

async function graphCall<T>(method: "GET" | "POST", path: string, params: Record<string, string>, token: string, what: string): Promise<T> {
  const query = new URLSearchParams({ ...params, access_token: token });
  const response = method === "GET"
    ? await fetch(`${graph}/${path}?${query}`, { cache: "no-store" })
    : await fetch(`${graph}/${path}`, { method: "POST", body: query, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string; error_user_msg?: string } };
  if (!response.ok || body.error) throw new PublishError(`Meta ${what} failed: ${body.error?.error_user_msg || body.error?.message || response.status}`);
  return body;
}

const isVertical = (a: LibraryAsset) => a.aspectRatioLabel === "9x16";
const isJpeg = (a: LibraryAsset) => /\.jpe?g$/i.test(a.filename) || a.mimeType === "image/jpeg";

// Instagram is two calls with a wait between: create a container, let Meta fetch and process it, publish.
export async function instagramContainer(token: PageToken, asset: LibraryAsset, caption: string) {
  if (!token.instagramId) throw new PublishError("No Instagram account is linked to this Page");
  if (asset.kind === "image" && !isJpeg(asset)) throw new PublishError("Instagram takes JPEG photos only; pick a .jpg");
  if (asset.kind !== "image" && asset.kind !== "video") throw new PublishError("Pick a photo or a video");
  const url = await mediaLink(asset.sourcePath);
  const params: Record<string, string> = asset.kind === "image"
    ? { image_url: url, caption }
    : { media_type: "REELS", video_url: url, caption, share_to_feed: "true" };
  const created = await graphCall<{ id: string }>("POST", `${token.instagramId}/media`, { ...params, is_ai_generated: "true" }, token.pageAccessToken, "Instagram upload");
  return { containerId: created.id, placement: asset.kind === "image" ? "post" : "reel" };
}

export async function instagramContainerStatus(token: PageToken, containerId: string) {
  const s = await graphCall<{ status_code?: string; status?: string }>("GET", containerId, { fields: "status_code,status" }, token.pageAccessToken, "Instagram status");
  return { status: s.status_code || "IN_PROGRESS", detail: s.status || null };
}

export async function instagramPublish(token: PageToken, containerId: string) {
  const published = await graphCall<{ id: string }>("POST", `${token.instagramId}/media_publish`, { creation_id: containerId }, token.pageAccessToken, "Instagram publish");
  const media = await graphCall<{ permalink?: string }>("GET", published.id, { fields: "permalink" }, token.pageAccessToken, "Instagram link").catch(() => ({ permalink: undefined }));
  return { id: published.id, url: media.permalink || `https://www.instagram.com/${token.instagramUsername || ""}` };
}

// Facebook Page: photos and wide videos post in one call; vertical videos go up as Reels
// (start → Meta pulls the file from the link → finish with PUBLISHED).
export async function facebookPost(token: PageToken, asset: LibraryAsset, caption: string) {
  const url = await mediaLink(asset.sourcePath);
  if (asset.kind === "image") {
    const photo = await graphCall<{ id: string; post_id?: string }>("POST", `${token.pageId}/photos`, { url, message: caption, published: "true" }, token.pageAccessToken, "Facebook photo");
    return { id: photo.post_id || photo.id, url: `https://www.facebook.com/${photo.post_id || photo.id}`, placement: "photo" };
  }
  if (asset.kind !== "video") throw new PublishError("Pick a photo or a video");
  if (!isVertical(asset)) {
    const video = await graphCall<{ id: string }>("POST", `${token.pageId}/videos`, { file_url: url, description: caption }, token.pageAccessToken, "Facebook video");
    return { id: video.id, url: `https://www.facebook.com/${token.pageId}/videos/${video.id}`, placement: "video" };
  }
  const start = await graphCall<{ video_id: string }>("POST", `${token.pageId}/video_reels`, { upload_phase: "start" }, token.pageAccessToken, "Facebook Reel start");
  const upload = await fetch(`https://rupload.facebook.com/video-upload/${META_GRAPH_VERSION}/${start.video_id}`, {
    method: "POST", headers: { authorization: `OAuth ${token.pageAccessToken}`, file_url: url }, cache: "no-store"
  });
  const uploaded = await upload.json().catch(() => ({})) as { success?: boolean; debug_info?: { message?: string } };
  if (!upload.ok || !uploaded.success) throw new PublishError(`Meta Facebook Reel upload failed: ${uploaded.debug_info?.message || upload.status}`);
  await graphCall("POST", `${token.pageId}/video_reels`, { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: caption, is_ai_generated: "true" }, token.pageAccessToken, "Facebook Reel publish");
  return { id: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}`, placement: "reel" };
}

export async function recordPublication(brand: string, destination: string, placement: string, assetId: string, externalPostId: string, externalUrl: string) {
  // The post is already live; a failed log only costs the dashboard tick, so report it instead of throwing.
  const { data } = await reviewCall({ brand, action: "record-publication", destination, placement, assetId, externalPostId, externalUrl }).catch(() => ({ data: { ok: false } }));
  return Boolean(data.ok);
}
