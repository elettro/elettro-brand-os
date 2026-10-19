import { NextRequest, NextResponse } from "next/server";
import { authenticated, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { META_APP_ID, META_BRANDS, META_CALLBACK, META_GRAPH_VERSION, META_SCOPES, META_STATE_COOKIE } from "@/lib/meta-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!META_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  const state = challenge();
  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", META_APP_ID);
  url.searchParams.set("redirect_uri", META_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", META_SCOPES.join(","));
  // rerequest re-asks for anything declined last time, so a reconnect can fix a missing Page or permission.
  url.searchParams.set("auth_type", "rerequest");
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(META_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
