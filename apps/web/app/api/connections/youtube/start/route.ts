import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { GOOGLE_CLIENT_ID, YOUTUBE_BRANDS, YOUTUBE_CALLBACK, YOUTUBE_SCOPES, YOUTUBE_STATE_COOKIE } from "@/lib/youtube-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  // Owner, or a user in this brand's Cognito group.
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  if (!YOUTUBE_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!GOOGLE_CLIENT_ID) return NextResponse.json({ error: "GOOGLE_OAUTH_CLIENT_ID is not configured" }, { status: 503 });
  const state = challenge();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", YOUTUBE_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  // offline + consent so Google always hands back a refresh token for unattended publishing.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(YOUTUBE_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
