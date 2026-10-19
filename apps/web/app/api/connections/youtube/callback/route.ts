import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { YOUTUBE_STATE_COOKIE } from "@/lib/youtube-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(YOUTUBE_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(YOUTUBE_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Google access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Google sent no code" });
  try {
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/youtube/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, code }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; channel?: { title?: string; handle?: string } };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: result.channel?.handle || result.channel?.title || "YouTube" });
  } catch (error) {
    console.error("YouTube connect callback failed", error instanceof Error ? error.name : "UnknownError");
    return done({ brand, error: "Elettro OS could not finish the connection" });
  }
}
