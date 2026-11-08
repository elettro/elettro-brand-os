import { NextRequest, NextResponse } from "next/server";
import { LINK_CODE, linksCall } from "@/lib/link-tracking";
import { connectKeyHeaders } from "@/lib/dev-api-key";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A bio-page tile's picture. Public, but only for the code of a tile that belongs to a published Instagram post:
// the dev-api answers the Dropbox path for such a code and nothing else, and the thumbnail is fetched with the connect key here.
const apiBase = process.env.BRAND_OS_API_BASE_URL || process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL || "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!LINK_CODE.test(code)) return NOT_FOUND();
  try {
    const { data } = await linksCall<{ ok?: boolean; path?: string }>({ action: "bio-image", code });
    if (!data?.ok || !data.path) return NOT_FOUND();
    const thumb = await fetch(`${apiBase}/dropbox/thumbnail?path=${encodeURIComponent(data.path)}&kind=image`,
      { headers: await connectKeyHeaders(), cache: "no-store", signal: AbortSignal.timeout(15000) });
    const type = thumb.headers.get("content-type") || "";
    if (!thumb.ok || !/^image\/(jpeg|png|webp)/i.test(type)) return NOT_FOUND();
    return new NextResponse(await thumb.arrayBuffer(), { status: 200, headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
  } catch (error) {
    console.error("Bio picture failed", error instanceof Error ? error.name : "UnknownError");
    return NOT_FOUND();
  }
}
