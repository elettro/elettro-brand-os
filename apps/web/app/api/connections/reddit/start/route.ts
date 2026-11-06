import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { REDDIT_BRANDS, REDDIT_CALLBACK, REDDIT_SCOPES, REDDIT_STATE_COOKIE, redditApp } from "@/lib/reddit-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!REDDIT_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  try {
    const app = await redditApp();
    const state = challenge();
    const url = new URL("https://www.reddit.com/api/v1/authorize");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", REDDIT_CALLBACK);
    // permanent = Reddit also returns a refresh token.
    url.searchParams.set("duration", "permanent");
    url.searchParams.set("scope", REDDIT_SCOPES.join(" "));
    const response = NextResponse.redirect(url);
    response.cookies.set(REDDIT_STATE_COOKIE, await seal([state, brand].join("|")), cookieSettings(600));
    return response;
  } catch (error) {
    console.error("Reddit connect start failed", error instanceof Error ? error.name : "UnknownError");
    // DEV_ORIGIN, not request.url: behind Amplify the request URL host is localhost:3000.
    return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ brand, network: "reddit", error: "Reddit is not set up yet" }) + "#reddit");
  }
}
