import { NextRequest, NextResponse } from "next/server";

const CANONICAL_HOST = "os.elettro.com";
const LEGACY_HOST = "develop.d2k28tehm1a8zw.amplifyapp.com";

// Pages opened on the original Amplify address move to os.elettro.com.
// Only an exact legacy Host redirects, so an unexpected proxy header can never loop.
// API routes, MCP discovery and the Claude upload page stay put for existing connectors.
export function middleware(request: NextRequest) {
  const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host")].map(value => (value || "").toLowerCase());
  if (hosts.includes(CANONICAL_HOST) || !hosts.includes(LEGACY_HOST)) return NextResponse.next();
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, "https://" + CANONICAL_HOST);
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: ["/((?!api/|_next/|\\.well-known/|epe-upload|favicon|tiktok).*)"],
};
