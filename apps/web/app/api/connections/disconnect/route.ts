import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, allowedOrigin, serverSetting } from "@/lib/cognito-auth";
import { tiktokWorker } from "@/lib/tiktok-worker";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

const NETWORKS = ["youtube", "gmb", "linkedin", "threads", "bluesky", "tiktok", "pinterest", "meta"];
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Disconnect one network for one brand. The owner, or a user in that brand's Cognito group, may do it.
// TikTok's grant is withdrawn at TikTok first; every network is then unlinked in the dev-api, which also
// holds the brand's approved-but-unsent posts for it.
export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return fail("Forbidden", 403);
  const body = await request.json().catch(() => ({})) as { brand?: string; network?: string };
  const brand = String(body.brand || "");
  const network = String(body.network || "");
  if (!NETWORKS.includes(network) || !/^[a-z0-9-]{2,40}$/.test(brand)) return fail("Unknown brand or network");
  if (!(await authenticatedFor(brand))) return fail("Log in to Elettro OS first", 401);
  try {
    if (network === "tiktok") {
      const revoked = await tiktokWorker({ action: "revoke", brand });
      if (!revoked.ok) return fail(revoked.error || "TikTok did not accept the disconnect", 502);
    }
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, network }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; postsHeld?: number };
    if (!response.ok || !result.ok) return fail(result.error || `Disconnect failed (HTTP ${response.status})`, 502);
    return NextResponse.json({ ok: true, postsHeld: result.postsHeld ?? 0 });
  } catch (error) {
    console.error("Disconnect failed", network, error instanceof Error ? error.name : "UnknownError");
    return fail("Elettro OS could not disconnect", 500);
  }
}
