import { NextRequest, NextResponse } from "next/server";
import { LINK_CODE, LINK_HOSTS } from "@/lib/link-hosts";

const CANONICAL_HOST = "os.elettro.com";
const LEGACY_HOST = "develop.d2k28tehm1a8zw.amplifyapp.com";
// Paths the legacy-host redirect leaves alone: API routes, MCP discovery and the Claude upload page stay put for existing connectors.
const LEGACY_PASS = /^\/(api\/|_next\/|\.well-known\/|epe-upload|favicon|tiktok)/;

export function middleware(request: NextRequest) {
  const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host")].map(value => (value || "").toLowerCase().split(":")[0]);
  const path = request.nextUrl.pathname;

  // A brand's short-link host (go.stashbox.ai) serves only its links and the Shopify pixel's endpoint;
  // anything else there goes to the brand's home page, so the rest of Elettro OS is never reachable on it.
  const linkHost = hosts.find((h) => h in LINK_HOSTS);
  if (linkHost) {
    const code = path.slice(1);
    if (LINK_CODE.test(code)) return NextResponse.rewrite(new URL(`/api/l/${code}`, request.url));
    // The Instagram bio-link page (go.stashbox.ai/bio) and its tile pictures; only on hosts that have one.
    if (LINK_HOSTS[linkHost].bio) {
      if (path === "/bio") return NextResponse.rewrite(new URL("/link-bio", request.url));
      if (path === "/link-bio" || /^\/api\/bio-img\/[^/]+$/.test(path)) return NextResponse.next();
    }
    if (path === "/api/link-events" || /^\/api\/l\/[^/]+$/.test(path) || path.startsWith("/_next/")) return NextResponse.next();
    return NextResponse.redirect(LINK_HOSTS[linkHost].home, 302);
  }

  // Pages opened on the original Amplify address move to os.elettro.com.
  // Only an exact legacy Host redirects, so an unexpected proxy header can never loop.
  if (LEGACY_PASS.test(path) || hosts.includes(CANONICAL_HOST) || !hosts.includes(LEGACY_HOST)) return NextResponse.next();
  const url = new URL(path + request.nextUrl.search, "https://" + CANONICAL_HOST);
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
