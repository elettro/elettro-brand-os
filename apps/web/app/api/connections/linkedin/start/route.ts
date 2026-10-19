import { NextRequest, NextResponse } from "next/server";
import { authenticated, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { LINKEDIN_BRANDS, LINKEDIN_CALLBACK, LINKEDIN_CLIENT_ID, LINKEDIN_SCOPES, LINKEDIN_STATE_COOKIE } from "@/lib/linkedin-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!LINKEDIN_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  const state = challenge();
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", LINKEDIN_CALLBACK);
  url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(LINKEDIN_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
