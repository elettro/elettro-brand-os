import { NextRequest, NextResponse } from "next/server";
import { authenticated, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { THREADS_APP_ID, THREADS_BRANDS, THREADS_CALLBACK, THREADS_SCOPES, THREADS_STATE_COOKIE } from "@/lib/threads-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!THREADS_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  const state = challenge();
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", THREADS_APP_ID);
  url.searchParams.set("redirect_uri", THREADS_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(THREADS_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
