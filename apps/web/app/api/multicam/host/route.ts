import { NextRequest, NextResponse } from "next/server";
import { session, allowedOrigin } from "@/lib/cognito-auth";
import { HOST_OPS, MULTICAM_BRANDS, multicamCall } from "@/lib/multicam";
export const runtime = "nodejs";

// Host side of Elettro MultiCam: owner only (the host is the only one who can open a session and show its QR code).
export async function POST(request: NextRequest) {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Log in to Elettro OS first" }, { status: 401 });
  if (!who.owner) return NextResponse.json({ ok: false, error: "Only the session host can do this" }, { status: 403 });
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !(HOST_OPS as readonly string[]).includes(String(body.op)) || !MULTICAM_BRANDS.includes(String(body.brand))) {
    return NextResponse.json({ ok: false, error: "Unknown brand or MultiCam action" }, { status: 400 });
  }
  try {
    const { status, data } = await multicamCall({ ...body, requestedBy: who.email });
    return NextResponse.json(data, { status });
  } catch (error) {
    console.error("MultiCam host call failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Elettro OS could not reach MultiCam" }, { status: 502 });
  }
}
