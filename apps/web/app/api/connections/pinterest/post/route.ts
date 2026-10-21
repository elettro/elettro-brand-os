import { NextRequest, NextResponse } from "next/server";
import { authenticated, allowedOrigin } from "@/lib/cognito-auth";
import { PINTEREST_BRANDS } from "@/lib/pinterest-connect";
import { PublishError, brandAsset, recordPublication } from "@/lib/meta-publish";
import { brandPinterestToken, createBoard, imagePin, listBoards, uploadVideo, videoPin, videoStatus } from "@/lib/pinterest-publish";
export const runtime = "nodejs";

type Body = { brand?: string; step?: string; boardId?: string; boardName?: string; assetId?: string; mediaId?: string; title?: string; description?: string; link?: string };

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

// "Post to Pinterest" on the Connections page: "boards" lists (or "board" creates) the account's
// boards, "pin" posts one approved library image or video to the chosen board. Videos go first
// through "video" (upload to Pinterest) and "media" (poll until processing succeeded), then "pin" with mediaId.
export async function POST(request: NextRequest) {
  // Same-origin only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return fail("Forbidden", 403);
  if (!(await authenticated())) return fail("Log in to Elettro OS first", 401);
  const body = await request.json().catch(() => ({})) as Body;
  const brand = String(body.brand || "");
  if (!PINTEREST_BRANDS.includes(brand)) return fail("Unknown brand");
  try {
    const token = await brandPinterestToken(brand);
    if (body.step === "boards") return NextResponse.json({ ok: true, boards: await listBoards(token) });
    if (body.step === "board") {
      const name = String(body.boardName || "").trim();
      if (!name || name.length > 50) return fail("Name the board (1 to 50 characters)");
      return NextResponse.json({ ok: true, board: await createBoard(token, name) });
    }
    if (body.step === "video") {
      const asset = await brandAsset(brand, String(body.assetId || ""));
      return NextResponse.json({ ok: true, ...await uploadVideo(token, asset) });
    }
    if (body.step === "media") {
      const mediaId = String(body.mediaId || "");
      if (!/^\d{5,25}$/.test(mediaId)) return fail("mediaId is required");
      return NextResponse.json({ ok: true, ...await videoStatus(token, mediaId) });
    }
    if (body.step === "pin") {
      const boardId = String(body.boardId || "");
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const link = String(body.link || "").trim();
      if (!/^\d{5,25}$/.test(boardId)) return fail("Pick a board");
      if (!title || title.length > 100) return fail("Write a title of 1 to 100 characters");
      if (description.length > 800) return fail("Descriptions allow up to 800 characters");
      if (link && !/^https:\/\/\S{4,2000}$/.test(link)) return fail("The link must start with https://");
      const asset = await brandAsset(brand, String(body.assetId || ""));
      const text = { title, description, link: link || null };
      let pin;
      if (asset.kind === "video") {
        const mediaId = String(body.mediaId || "");
        if (!/^\d{5,25}$/.test(mediaId)) return fail("Upload the video first");
        pin = await videoPin(token, boardId, mediaId, asset, text);
      } else {
        pin = await imagePin(token, boardId, asset, text);
      }
      const logged = await recordPublication(brand, "pinterest", asset.kind === "video" ? "video" : "pin", asset.id, pin.id, pin.url);
      return NextResponse.json({ ok: true, url: pin.url, logged });
    }
    return fail("Unknown step");
  } catch (error) {
    if (error instanceof PublishError) return fail(error.message, 502);
    console.error("Pinterest post failed", error instanceof Error ? error.name : "UnknownError");
    return fail("Elettro OS could not send the Pin", 500);
  }
}
