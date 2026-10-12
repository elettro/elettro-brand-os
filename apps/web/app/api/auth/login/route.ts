import { NextResponse } from "next/server";
import { CALLBACK, COGNITO_CLIENT_ID, COGNITO_DOMAIN, STATE_COOKIE, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
export const runtime = "nodejs";
export async function GET() {
  try {
    const state = challenge();
    const url = new URL(COGNITO_DOMAIN + "/oauth2/authorize");
    url.searchParams.set("client_id", COGNITO_CLIENT_ID);
    url.searchParams.set("redirect_uri", CALLBACK);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    const response = NextResponse.redirect(url);
    response.cookies.set(STATE_COOKIE, seal(state), cookieSettings(600));
    return response;
  } catch {
    return NextResponse.json({ error: "Cognito authentication is not configured yet" }, { status: 503 });
  }
}
