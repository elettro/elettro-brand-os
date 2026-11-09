import { NextRequest, NextResponse } from "next/server";
import { authenticatedFor } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { PublishError, brandAsset, mediaLink } from "@/lib/meta-publish";
export const runtime = "nodejs";

// TikTok's card shows a playable preview of the exact video before the creator approves it.
// Owner, or a user in this brand's Cognito group; the asset must be a video in this brand's approved library.
// The link is a short-lived Dropbox temporary link, never stored.
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  const assetId = request.nextUrl.searchParams.get("assetId") || "";
  if (!(await authenticatedFor(brand))) return NextResponse.json({ ok: false, error: "Log in to Elettro OS first" }, { status: 401 });
  if (!TIKTOK_BRANDS.includes(brand)) return NextResponse.json({ ok: false, error: "Unknown brand" }, { status: 400 });
  try {
    const asset = await brandAsset(brand, assetId);
    if (asset.kind !== "video") return NextResponse.json({ ok: false, error: "Only videos can be previewed" }, { status: 400 });
    return NextResponse.json({ ok: true, url: await mediaLink(asset.sourcePath) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof PublishError) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    console.error("TikTok preview failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Elettro OS could not load the preview" }, { status: 502 });
  }
}
