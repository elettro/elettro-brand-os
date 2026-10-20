import { NextRequest, NextResponse } from "next/server";
import { authenticated, allowedOrigin } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { tiktokWorker } from "@/lib/tiktok-worker";
import { PublishError, brandAsset, recordPublication } from "@/lib/meta-publish";
export const runtime = "nodejs";

type Body = { brand?: string; step?: string; assetId?: string; caption?: string; publishId?: string; settings?: Record<string, unknown> };

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// "Post to TikTok" on the Connections page: Dean picks a library video, sets TikTok's required
// options on the TikTok card and sends it. The worker uploads it from Dropbox as a direct post;
// "status" follows it through TikTok's processing.
export async function POST(request: NextRequest) {
  // Same-origin only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return fail("Forbidden", 403);
  if (!(await authenticated())) return fail("Log in to Elettro OS first", 401);
  const body = await request.json().catch(() => ({})) as Body;
  const brand = String(body.brand || "");
  if (!TIKTOK_BRANDS.includes(brand)) return fail("Unknown brand");
  try {
    if (body.step === "status") {
      const status = await tiktokWorker<{ status?: string; failReason?: string; postIds?: string[] }>({ action: "status", brand, publishId: body.publishId });
      return status.ok ? NextResponse.json(status) : fail(status.error || "TikTok status check failed", 502);
    }
    const caption = String(body.caption || "").trim();
    if (caption.length > 2200) return fail("TikTok captions allow up to 2,200 characters");
    const asset = await brandAsset(brand, String(body.assetId || ""));
    if (asset.kind !== "video") return fail("TikTok posts here are videos; pick a video");
    const posted = await tiktokWorker<{ publishId?: string; handle?: string; status?: string }>({
      action: "post", brand, mode: "direct", dropboxPath: asset.sourcePath, caption, settings: body.settings || {}
    });
    if (!posted.ok || !posted.publishId) return fail(posted.error || "TikTok post failed", 502);
    const profile = posted.handle?.startsWith("@") ? `https://www.tiktok.com/${posted.handle}` : "";
    const logged = await recordPublication(brand, "tiktok", "video", asset.id, posted.publishId, profile);
    return NextResponse.json({ ok: true, publishId: posted.publishId, handle: posted.handle, status: posted.status, profile, logged });
  } catch (error) {
    if (error instanceof PublishError) return fail(error.message, 502);
    console.error("TikTok post failed", error instanceof Error ? error.name : "UnknownError");
    return fail("Elettro OS could not send the post", 500);
  }
}
