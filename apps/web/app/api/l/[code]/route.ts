import { NextRequest, NextResponse } from "next/server";
import { LINK_CODE, homeForHost, linksCall } from "@/lib/link-tracking";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A tracked short link (go.stashbox.ai/<code>, rewritten here by middleware.ts). Public: the code is all it takes.
// Counts the click (or a link-preview robot) and forwards to the store page with the post's code and utm fields.
// If anything fails the visitor still lands on the brand's home page, never on an error.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const home = homeForHost(host);
  const go = (url: string) => NextResponse.redirect(url, { status: 302, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer-when-downgrade" } });
  if (!LINK_CODE.test(code)) return go(home);
  try {
    const { data } = await linksCall<{ ok?: boolean; location?: string }>({
      action: "click", code,
      userAgent: (request.headers.get("user-agent") || "").slice(0, 400),
      referrer: (request.headers.get("referer") || "").slice(0, 400)
    });
    return go(data?.ok && typeof data.location === "string" && /^https:\/\//.test(data.location) ? data.location : home);
  } catch (error) {
    console.error("Tracked link lookup failed", error instanceof Error ? error.name : "UnknownError");
    return go(home);
  }
}
