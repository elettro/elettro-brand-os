import { NextRequest, NextResponse } from "next/server";
import { allowedOrigin } from "@/lib/cognito-auth";
import { BAND_OPS, multicamCall } from "@/lib/multicam";
export const runtime = "nodejs";

// Band side of Elettro MultiCam: public, no login. The session code from the host's QR is the only credential and the
// dev-api checks it (valid, open, not expired) on every call; only the band ops are allowed through here.
const FIELDS = ["op", "code", "songId", "title", "contributor", "angle", "filename", "size", "contentType", "clipId", "parts"];

export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const raw = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw || !(BAND_OPS as readonly string[]).includes(String(raw.op)) || typeof raw.code !== "string" || raw.code.length > 20) {
    return NextResponse.json({ ok: false, error: "This MultiCam link is not valid" }, { status: 400 });
  }
  if (raw.parts !== undefined && (!Array.isArray(raw.parts) || raw.parts.length > 10000)) {
    return NextResponse.json({ ok: false, error: "Invalid upload parts" }, { status: 400 });
  }
  // Pass only the fields the band ops use; nothing like brand or sessionId can be smuggled to a host op.
  const body = Object.fromEntries(FIELDS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  try {
    const { status, data } = await multicamCall(body);
    return NextResponse.json(data, { status });
  } catch (error) {
    console.error("MultiCam band call failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Could not reach Elettro OS. Check your connection and try again." }, { status: 502 });
  }
}
