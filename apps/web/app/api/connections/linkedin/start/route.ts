import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import {
  LINKEDIN_BRANDS, LINKEDIN_CALLBACK, LINKEDIN_CLIENT_ID, LINKEDIN_PAGES_CLIENT_ID, LINKEDIN_PAGES_SCOPES, LINKEDIN_PAGE_BRANDS,
  LINKEDIN_SCOPES, LINKEDIN_STATE_COOKIE
} from "@/lib/linkedin-connect";
export const runtime = "nodejs";
// ?brand=<id> connects the brand's personal profile ("Elettro OS Personal" app); add &kind=page to connect its company page ("Elettro OS" app).
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  const page = request.nextUrl.searchParams.get("kind") === "page";
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  if (!(page ? LINKEDIN_PAGE_BRANDS : LINKEDIN_BRANDS).includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  const state = challenge();
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", page ? LINKEDIN_PAGES_CLIENT_ID : LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", LINKEDIN_CALLBACK);
  url.searchParams.set("scope", (page ? LINKEDIN_PAGES_SCOPES : LINKEDIN_SCOPES).join(" "));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(LINKEDIN_STATE_COOKIE, await seal(state + "|" + brand + (page ? "|page" : "")), cookieSettings(600));
  return response;
}
