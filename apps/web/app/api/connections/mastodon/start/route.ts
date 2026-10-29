import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { MASTODON_BRANDS, MASTODON_CALLBACK, MASTODON_SCOPES, MASTODON_STATE_COOKIE, mastodonApp } from "@/lib/mastodon-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!MASTODON_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  try {
    const app = await mastodonApp();
    const state = challenge();
    const url = new URL(`https://${app.instance}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", MASTODON_CALLBACK);
    url.searchParams.set("scope", MASTODON_SCOPES.join(" "));
    url.searchParams.set("state", state);
    // Always show the login page, so each brand signs in with its own profile instead of whichever one the browser remembers.
    url.searchParams.set("force_login", "true");
    const response = NextResponse.redirect(url);
    response.cookies.set(MASTODON_STATE_COOKIE, await seal(state + "|" + brand), cookieSettings(600));
    return response;
  } catch (error) {
    console.error("Mastodon connect start failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.redirect(new URL("/connections?" + new URLSearchParams({ brand, error: "Mastodon is not set up yet" }), request.url));
  }
}
