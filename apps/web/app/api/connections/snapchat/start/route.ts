import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { SNAPCHAT_AUTHORIZE_URL, SNAPCHAT_BRANDS, SNAPCHAT_CALLBACK, SNAPCHAT_SCOPE, SNAPCHAT_STATE_COOKIE, snapchatApp } from "@/lib/snapchat-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!SNAPCHAT_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  let clientId: string;
  try { clientId = (await snapchatApp()).clientId; } catch {
    return NextResponse.redirect(new URL("/connections?" + new URLSearchParams({ brand, network: "snapchat", error: "Snapchat is not set up yet: the app credentials are missing" }), request.url));
  }
  const state = challenge();
  const url = new URL(SNAPCHAT_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", SNAPCHAT_CALLBACK);
  url.searchParams.set("scope", SNAPCHAT_SCOPE);
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(SNAPCHAT_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
