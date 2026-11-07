import { serverSetting } from "@/lib/cognito-auth";

// Tracked links (runbook docs/admin/link-tracking.md). The brand's short-link host (go.stashbox.ai) is an extra Amplify
// domain on this app: /<code> counts the click and forwards to the store; /api/link-events takes the Shopify pixel's
// store events. Both reach the dev-api's POST /links server-side with the connect key; the browser never sees it.

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

export { LINK_HOSTS, FALLBACK_HOME, LINK_CODE, PIXEL_KINDS, homeForHost } from "@/lib/link-hosts";

export async function linksCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
  const response = await fetch(`${apiBaseUrl}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-elettro-connect-key": key },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => ({ ok: false })) as T;
  return { status: response.status, data };
}
