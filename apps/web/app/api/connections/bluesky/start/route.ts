import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor, cookieSettings } from "@/lib/cognito-auth";
import { BLUESKY_BRANDS, BLUESKY_ENTRYWAY, BLUESKY_STATE_COOKIE, blueskyClient, encryptState } from "@/lib/bluesky-connect";
export const runtime = "nodejs";

const back = (request: NextRequest, brand: string, error: string) =>
  NextResponse.redirect(new URL("/connections?" + new URLSearchParams({ brand, error, network: "bluesky" }), request.url));

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!BLUESKY_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  // A handle ("stashbox.bsky.social", a custom domain) or blank. Anything else is refused before it reaches Bluesky.
  const handle = (request.nextUrl.searchParams.get("handle") || "").trim().replace(/^@/, "").toLowerCase();
  if (handle && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(handle)) {
    return back(request, brand, "That is not a Bluesky handle (example: yourname.bsky.social)");
  }
  try {
    const { client, states } = await blueskyClient();
    const url = await client.authorize(handle || BLUESKY_ENTRYWAY, { scope: "atproto transition:generic" });
    const response = NextResponse.redirect(url);
    // The library's per-login state travels in a sealed cookie; the callback puts it back.
    response.cookies.set(BLUESKY_STATE_COOKIE, await encryptState(JSON.stringify({ brand, states: [...states.entries()] })), cookieSettings(600));
    return response;
  } catch (error) {
    console.error("Bluesky start failed", error instanceof Error ? error.message : "UnknownError");
    return back(request, brand, "Could not start the Bluesky login");
  }
}
