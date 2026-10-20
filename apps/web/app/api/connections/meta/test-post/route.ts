import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticated } from "@/lib/cognito-auth";
import { META_BRANDS } from "@/lib/meta-connect";
import { reviewCall } from "@/lib/planner-review";
import {
  PublishError, brandAsset, brandPageToken, facebookPost, instagramContainer, instagramContainerStatus, instagramPublish, recordPublication
} from "@/lib/meta-publish";
export const runtime = "nodejs";

type Body = { brand?: string; network?: string; step?: string; assetId?: string; caption?: string; containerId?: string; placement?: string };

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// Test posts from the Connections page, one asset Dean picks per network. Instagram runs in
// steps (start → status until FINISHED → publish) so a Reel's processing never hits a timeout.
export async function POST(request: NextRequest) {
  // Same-origin only, so another site can't post on Dean's behalf with his session cookie.
  if (request.headers.get("origin") !== DEV_ORIGIN) return fail("Forbidden", 403);
  if (!(await authenticated())) return fail("Log in to Elettro OS first", 401);
  const body = await request.json().catch(() => ({})) as Body;
  const brand = String(body.brand || "");
  const caption = String(body.caption || "").trim();
  if (!META_BRANDS.includes(brand)) return fail("Unknown brand");
  try {
    const token = await brandPageToken(brand);
    if (body.network === "instagram") {
      if (body.step === "start") {
        if (!caption || caption.length > 2200) return fail("Write a caption of 1 to 2,200 characters");
        const asset = await brandAsset(brand, String(body.assetId || ""));
        return NextResponse.json({ ok: true, ...await instagramContainer(token, asset, caption) });
      }
      const containerId = String(body.containerId || "");
      if (!/^\d{5,25}$/.test(containerId)) return fail("containerId is required");
      if (body.step === "status") return NextResponse.json({ ok: true, ...await instagramContainerStatus(token, containerId) });
      if (body.step === "publish") {
        const asset = await brandAsset(brand, String(body.assetId || ""));
        const post = await instagramPublish(token, containerId);
        const logged = await recordPublication(brand, "instagram", body.placement === "reel" ? "reel" : "post", asset.id, post.id, post.url);
        return NextResponse.json({ ok: true, url: post.url, logged });
      }
      return fail("Unknown step");
    }
    if (body.network === "facebook") {
      if (!caption || caption.length > 5000) return fail("Write a caption of 1 to 5,000 characters");
      const asset = await brandAsset(brand, String(body.assetId || ""));
      // Dean wants the Page to show something different from the latest Instagram test post.
      const recent = await reviewCall<{ publications?: Array<{ destination: string; assetId: string }> }>({ brand, action: "recent-publications" });
      if (recent.data.publications?.find((p) => p.destination === "instagram")?.assetId === asset.id) {
        return fail("That is the asset just posted to Instagram; pick a different one for Facebook");
      }
      const post = await facebookPost(token, asset, caption);
      const logged = await recordPublication(brand, "facebook", post.placement, asset.id, post.id, post.url);
      return NextResponse.json({ ok: true, url: post.url, logged });
    }
    return fail("Unknown network");
  } catch (error) {
    if (error instanceof PublishError) return fail(error.message, 502);
    console.error("Meta test post failed", error instanceof Error ? error.name : "UnknownError");
    return fail("Elettro OS could not send the post", 500);
  }
}
