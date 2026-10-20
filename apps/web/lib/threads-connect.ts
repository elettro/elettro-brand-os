import { createHmac, timingSafeEqual } from "node:crypto";
import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Meta for Developers → app "Elettro OS" (1186765853901766), use case "Access the Threads API".
// Threads has its own app ID and secret; the ID is public, the secret lives only in
// Secrets Manager (elettro-brand-os-dev/threads-oauth).
export const THREADS_APP_ID = process.env.THREADS_APP_ID || "29447881421485899";
export const THREADS_CALLBACK = DEV_ORIGIN + "/api/connections/threads/callback";
export const THREADS_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_delete",
  "threads_manage_insights",
  "threads_manage_replies",
  "threads_read_replies"
];
export const THREADS_STATE_COOKIE = "elettro_dev_threads_state";
// Same brands as Meta; Stashbox (@stashboxmusic) first. While the app is in dev mode each
// account must be a Threads Tester that accepted the invite in Threads → Settings → Account → Website permissions.
export const THREADS_BRANDS = ["stashbox", "elettro", "therasbox", "solarmeister"];
export const THREADS_OAUTH_SECRET = "elettro-brand-os-dev/threads-oauth";

// Meta's uninstall and data-deletion callbacks POST signed_request = "<sig>.<payload>", both base64url,
// sig = HMAC-SHA256(payload) with the Threads app secret.
export function verifySignedRequest(signedRequest: string, appSecret: string): { user_id?: string } | null {
  const [sig, payload] = signedRequest.split(".");
  if (!sig || !payload || !appSecret) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}
