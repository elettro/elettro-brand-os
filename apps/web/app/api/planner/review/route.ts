import { NextRequest, NextResponse } from "next/server";
import { session, allowedOrigin } from "@/lib/cognito-auth";
import { canAccessBrand } from "@/lib/brand-access";
import { REVIEW_BRANDS, reviewCall } from "@/lib/planner-review";
export const runtime = "nodejs";

// "asset" and "record-publication" stay server-only (test-post route), so the browser cannot forge the publication log.
const ACTIONS = ["list", "set-status", "approve-range", "reset-week", "edit", "tiktok-approve", "swap", "cadence", "plan", "assets", "recent-publications"];

// Same-origin proxy for the Review page; the browser never sees the connect key.
export async function POST(request: NextRequest) {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Log in to Elettro OS first" }, { status: 401 });
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !REVIEW_BRANDS.includes(String(body.brand)) || !ACTIONS.includes(String(body.action))) {
    return NextResponse.json({ ok: false, error: "Unknown brand or action" }, { status: 400 });
  }
  if (!canAccessBrand(who, String(body.brand))) return NextResponse.json({ ok: false, error: "No access to this brand" }, { status: 403 });
  try {
    const { status, data } = await reviewCall(body);
    return NextResponse.json(data, { status });
  } catch (error) {
    console.error("Review action failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Elettro OS could not reach the planner" }, { status: 502 });
  }
}
