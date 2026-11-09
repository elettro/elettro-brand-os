import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS, TIKTOK_CALLBACK, TIKTOK_SCOPES, TIKTOK_STATE_COOKIE, tiktokApp } from "@/lib/tiktok-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  // Owner, or a user in this brand's Cognito group (so a client connects its own TikTok). The login address is built from
  // DEV_ORIGIN: request.url is the server's internal address (localhost:3000) behind Amplify.
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(DEV_ORIGIN + "/api/auth/login");
  if (!TIKTOK_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  let clientKey: string;
  try {
    ({ clientKey } = await tiktokApp());
  } catch (error) {
    const message = error instanceof Error && /^TikTok/.test(error.message) ? error.message : "TikTok app keys could not be read";
    return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ brand, error: message }));
  }
  const state = challenge();
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("redirect_uri", TIKTOK_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(TIKTOK_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
  return response;
}
