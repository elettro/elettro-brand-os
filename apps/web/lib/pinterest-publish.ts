import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { PublishError, mediaLink, type LibraryAsset } from "@/lib/meta-publish";

// Server only. Pins go to a board on the brand's connected Pinterest account with the access
// token from "Connect Pinterest". Images go up by URL: a 4-hour Dropbox link Pinterest fetches itself.
const secrets = new SecretsManagerClient({ region: "us-east-1" });
const TOKEN_PREFIX = "elettro-brand-os-dev/pinterest/";
const api = "https://api.pinterest.com/v5";

type Token = { accessToken: string; accessExpiresAt: string; userId: string; username: string | null; brand: string; brands?: string[] };
export type Board = { id: string; name: string; privacy: string };

export async function brandPinterestToken(brand: string): Promise<Token> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as Token;
    if (!(token.brands || [token.brand]).includes(brand) || !token.accessToken) continue;
    // Access tokens last 30 days; renewing them (refresh token) is the token worker's job.
    if (Date.parse(token.accessExpiresAt) <= Date.now()) throw new PublishError("The Pinterest login expired; click Reconnect");
    return token;
  }
  throw new PublishError("Connect Pinterest for this brand first");
}

async function pinterestCall<T>(token: Token, method: "GET" | "POST", path: string, body: unknown, what: string): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token.accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new PublishError(`Pinterest ${what} failed: ${data.message || response.status}`);
  return data;
}

export async function listBoards(token: Token): Promise<Board[]> {
  const data = await pinterestCall<{ items?: Board[] }>(token, "GET", "/boards?page_size=100", null, "board list");
  return (data.items || []).map((b) => ({ id: b.id, name: b.name, privacy: b.privacy }));
}

export async function createBoard(token: Token, name: string): Promise<Board> {
  const b = await pinterestCall<Board>(token, "POST", "/boards", { name, privacy: "PUBLIC" }, "board create");
  return { id: b.id, name: b.name, privacy: b.privacy };
}

// Video Pins: register the upload with Pinterest, copy the file from Dropbox into the upload
// form Pinterest returns (its S3 bucket), then poll until processing "succeeded" and pin it.
// The copy runs inside one web request, so very large files are refused up front.
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;

export async function uploadVideo(token: Token, asset: LibraryAsset) {
  if (asset.kind !== "video") throw new PublishError("Pick a video");
  if (asset.durationMs && (asset.durationMs < 4000 || asset.durationMs > 15 * 60_000)) throw new PublishError("Pinterest videos must be 4 seconds to 15 minutes long");
  const registered = await pinterestCall<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>(
    token, "POST", "/media", { media_type: "video" }, "video register");
  const source = await fetch(await mediaLink(asset.sourcePath), { cache: "no-store" });
  if (!source.ok) throw new PublishError("Dropbox could not send that file");
  if (Number(source.headers.get("content-length") || 0) > MAX_VIDEO_BYTES) throw new PublishError("That video is over 150 MB; pick a shorter or smaller one");
  const file = await source.blob();
  if (file.size > MAX_VIDEO_BYTES) throw new PublishError("That video is over 150 MB; pick a shorter or smaller one");
  const form = new FormData();
  for (const [key, value] of Object.entries(registered.upload_parameters)) form.append(key, value);
  form.append("file", file, asset.filename);
  const uploaded = await fetch(registered.upload_url, { method: "POST", body: form, cache: "no-store" });
  if (!uploaded.ok) throw new PublishError(`Pinterest video upload failed: ${uploaded.status}`);
  return { mediaId: registered.media_id };
}

export async function videoStatus(token: Token, mediaId: string) {
  const m = await pinterestCall<{ status?: string }>(token, "GET", `/media/${mediaId}`, null, "video status");
  return { status: m.status || "registered" };
}

export async function videoPin(token: Token, boardId: string, mediaId: string, asset: LibraryAsset, pin: { title: string; description: string; link: string | null }) {
  const created = await pinterestCall<{ id: string }>(token, "POST", "/pins", {
    board_id: boardId,
    title: pin.title,
    description: pin.description,
    ...(pin.link ? { link: pin.link } : {}),
    alt_text: (asset.title || pin.title).slice(0, 500),
    // Cover = the frame one second in, so a fade-in from black never becomes the thumbnail.
    media_source: { source_type: "video_id", media_id: mediaId, cover_image_key_frame_time: 1 }
  }, "Pin create");
  return { id: created.id, url: `https://www.pinterest.com/pin/${created.id}/` };
}

// One image Pin. Title and description are Pinterest's limits (100 / 800); the link makes the Pin clickable.
export async function imagePin(token: Token, boardId: string, asset: LibraryAsset, pin: { title: string; description: string; link: string | null }) {
  if (asset.kind !== "image") throw new PublishError("Pinterest posts here are images; pick a photo");
  const url = await mediaLink(asset.sourcePath);
  const created = await pinterestCall<{ id: string }>(token, "POST", "/pins", {
    board_id: boardId,
    title: pin.title,
    description: pin.description,
    ...(pin.link ? { link: pin.link } : {}),
    alt_text: (asset.title || pin.title).slice(0, 500),
    media_source: { source_type: "image_url", url }
  }, "Pin create");
  return { id: created.id, url: `https://www.pinterest.com/pin/${created.id}/` };
}
