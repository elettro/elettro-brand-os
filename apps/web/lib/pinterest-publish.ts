import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { PublishError, mediaLink, type LibraryAsset } from "@/lib/meta-publish";

// Server only. Pins go to a board on the brand's connected Pinterest account with the access
// token from "Connect Pinterest". Images go up by URL: a 4-hour Dropbox link Pinterest fetches itself.
const secrets = new SecretsManagerClient({ region: "us-east-1" });
const TOKEN_PREFIX = "elettro-brand-os-dev/pinterest/";
const api = "https://api.pinterest.com/v5";

type Token = { accessToken: string; accessExpiresAt: string; userId: string; username: string | null; brand: string };
export type Board = { id: string; name: string; privacy: string };

export async function brandPinterestToken(brand: string): Promise<Token> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as Token;
    if (token.brand !== brand || !token.accessToken) continue;
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
