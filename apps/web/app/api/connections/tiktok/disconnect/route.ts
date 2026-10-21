import { NextRequest, NextResponse } from "next/server";
import { authenticated, allowedOrigin, serverSetting } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { tiktokWorker } from "@/lib/tiktok-worker";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Disconnect a brand's TikTok: the worker revokes the grant at TikTok, then the brand's TikTok row
// is unlinked (same Lambda route as Connect, action "disconnect").
export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return fail("Forbidden", 403);
  if (!(await authenticated())) return fail("Log in to Elettro OS first", 401);
  const body = await request.json().catch(() => ({})) as { brand?: string };
  const brand = String(body.brand || "");
  if (!TIKTOK_BRANDS.includes(brand)) return fail("Unknown brand");
  try {
    const revoked = await tiktokWorker<{ revoked?: boolean }>({ action: "revoke", brand });
    if (!revoked.ok) return fail(revoked.error || "TikTok did not accept the disconnect", 502);
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/tiktok/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ action: "disconnect", brand }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) return fail(result.error || `Disconnect failed (HTTP ${response.status})`, 502);
    return NextResponse.json({ ok: true, revoked: revoked.revoked === true });
  } catch (error) {
    console.error("TikTok disconnect failed", error instanceof Error ? error.name : "UnknownError");
    return fail("Elettro OS could not disconnect TikTok", 500);
  }
}
