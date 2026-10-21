import { NextRequest, NextResponse } from "next/server";
import { authenticated, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { PINTEREST_APP_ID, PINTEREST_BRANDS, PINTEREST_CALLBACK, PINTEREST_SCOPES, PINTEREST_STATE_COOKIE } from "@/lib/pinterest-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!PINTEREST_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  const state = challenge();
  const url = new URL("https://www.pinterest.com/oauth/");
  url.searchParams.set("client_id", PINTEREST_APP_ID);
  url.searchParams.set("redirect_uri", PINTEREST_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PINTEREST_SCOPES.join(","));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(PINTEREST_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
