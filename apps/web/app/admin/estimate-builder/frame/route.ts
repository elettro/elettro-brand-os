import { NextResponse } from "next/server";
import { authenticated } from "@/lib/cognito-auth";
import { ESTIMATOR_HTML } from "@/lib/estimator-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" };

// Owner-only (the same check as the other Admin pages). Anyone else, signed in or not, gets a plain 404.
export async function GET() {
  if (!(await authenticated())) return new NextResponse("Not found", { status: 404, headers: HEADERS });
  return new NextResponse(ESTIMATOR_HTML, {
    headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "same-origin" }
  });
}
