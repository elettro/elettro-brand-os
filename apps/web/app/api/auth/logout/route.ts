import { NextResponse } from "next/server";
import { AUTH_COOKIE, STATE_COOKIE, DEV_ORIGIN, COGNITO_DOMAIN, COGNITO_CLIENT_ID } from "@/lib/cognito-auth";
export const runtime = "nodejs";
// Only local session cookies are removed until Cognito sign-out is configured.
// Cognito's logout endpoint signs out the managed-login browser session too.
export async function GET() {
  const url = new URL(COGNITO_DOMAIN + "/logout");
  url.searchParams.set("client_id", COGNITO_CLIENT_ID);
  url.searchParams.set("logout_uri", DEV_ORIGIN + "/");
  const response = NextResponse.redirect(url);
  response.cookies.delete(AUTH_COOKIE);
  response.cookies.delete(STATE_COOKIE);
  return response;
}
