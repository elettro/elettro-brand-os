import { serverSetting } from "@/lib/cognito-auth";

// Elettro MultiCam: server-side calls to the dev-api's POST /multicam (spec: docs/multicam/ELETTRO-MULTICAM-SPEC.md).
// The browser never sees the connect key; the host and band pages go through /api/multicam/{host,band}.

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Kept in step with HOST_OPS / BAND_OPS in services/dev-api-lambda/multicam.mjs.
export const HOST_OPS = ["create-session", "list-sessions", "get-session", "add-song", "end-session", "reopen-session", "request-make", "clip-download"] as const;
export const BAND_OPS = ["join", "band-add-song", "start-upload", "complete-upload", "abort-upload"] as const;

// Brands that can run a MultiCam session (Stashbox first; add a brand here to open it up).
export const MULTICAM_BRANDS = ["stashbox", "elettro"];

// The address band members open; the QR code encodes it.
export const MULTICAM_PUBLIC_ORIGIN = process.env.MULTICAM_PUBLIC_ORIGIN || "https://os.elettro.com";
export function bandLink(code: string): string { return `${MULTICAM_PUBLIC_ORIGIN}/mc/${code}`; }

export async function multicamCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
  const response = await fetch(`${apiBaseUrl}/multicam`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-elettro-connect-key": key },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({ ok: false, error: `MultiCam API returned HTTP ${response.status}` })) as T;
  return { status: response.status, data };
}

export type McClip = { id: string; songId: string; contributor: string; angle: string; kind: string; filename: string; sizeBytes: number; status: string; createdAt: string; completedAt: string | null };
export type McSong = { id: string; title: string; slug: string; status: string; makeRequestedAt: string | null; longTake: boolean; clips: McClip[] };
export type McSession = {
  id: string; brand: string; brandName: string; code: string; title: string | null; location: string; sessionDate: string;
  status: string; expiresAt: string; open: boolean; folder: string; deliveryFolder: string;
};
export type McSessionDetail = { ok: boolean; error?: string; session: McSession; songs: McSong[] };
export type McSessionRow = { id: string; title: string | null; location: string; sessionDate: string; status: string; open: boolean; songCount: number; clipCount: number };
