import { NextRequest, NextResponse } from "next/server";
import { LINK_CODE, PIXEL_KINDS, linksCall } from "@/lib/link-tracking";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Store events from the brand's Shopify custom pixel (docs/admin/link-tracking/stashbox-pixel.js). Public and
// cross-origin: Shopify runs custom pixels in a sandbox with no usable origin, so any origin may post. The pixel sends
// text/plain JSON (no preflight). The dev-api ignores codes it never issued and de-duplicates by Shopify's event id.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: NextRequest) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > 4000) return NextResponse.json({ ok: false }, { status: 400, headers: CORS });
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { return NextResponse.json({ ok: false }, { status: 400, headers: CORS }); }
  const kind = String(raw?.kind || "");
  if (!LINK_CODE.test(String(raw?.code || "")) || !(PIXEL_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ ok: false }, { status: 400, headers: CORS });
  }
  const body: Record<string, unknown> = { action: "event", code: raw.code, kind };
  for (const k of ["product", "value", "currency", "eventId"]) if (raw[k] !== undefined) body[k] = raw[k];
  try {
    const { status, data } = await linksCall(body);
    return NextResponse.json(data, { status, headers: CORS });
  } catch (error) {
    console.error("Link event failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false }, { status: 502, headers: CORS });
  }
}
