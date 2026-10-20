import { NextRequest, NextResponse } from "next/server";
import { authenticated } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { tiktokWorker } from "@/lib/tiktok-worker";
export const runtime = "nodejs";

// The TikTok cards: TikTok wants the account name, avatar and the allowed privacy and interaction
// settings read fresh from creator_info whenever the creator is about to approve or send a post.
// The token lives with the TikTok worker, so the worker asks TikTok.
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.json({ ok: false, error: "Log in to Elettro OS first" }, { status: 401 });
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!TIKTOK_BRANDS.includes(brand)) return NextResponse.json({ ok: false, error: "Unknown brand" }, { status: 400 });
  try {
    const info = await tiktokWorker({ action: "creator-info", brand });
    if (!info.ok) return NextResponse.json({ ok: false, error: info.error || "TikTok account lookup failed" }, { status: 502 });
    return NextResponse.json(info, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("TikTok creator info failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Elettro OS could not reach the TikTok worker" }, { status: 502 });
  }
}
