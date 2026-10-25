import { NextRequest, NextResponse } from "next/server";
import { allowedOrigin, session } from "@/lib/cognito-auth";
import { connectKeyHeaders } from "@/lib/dev-api-key";
import { brandConfigs } from "@/lib/brand-config";
import { mergeBrandTags, SHARED_LIBRARY } from "@/lib/client-scope";
import { getAsset } from "@/lib/dev-api-server";

export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A signed-in user changes which of their own brands a shared creative asset is tagged for, and nothing else.
// The owner may tag any brand; a client's changes are limited to the brands in their session, and other brands' tags are kept.
export async function POST(request: NextRequest) {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Login required" }, { status: 401 });
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });

  const body = await request.json().catch(() => null) as { assetId?: unknown; brands?: unknown } | null;
  const assetId = typeof body?.assetId === "string" && UUID.test(body.assetId) ? body.assetId : null;
  const requested = Array.isArray(body?.brands) ? body!.brands.filter((b): b is string => typeof b === "string") : null;
  if (!assetId || !requested) return NextResponse.json({ ok: false, error: "assetId and brands are required" }, { status: 400 });

  const known = brandConfigs.map((b) => b.id as string);
  const mine = who.owner ? known : who.brands.filter((b) => known.includes(b));
  try {
    const { asset } = await getAsset(assetId, who.owner ? null : who.brands);
    if (asset.brandSlug !== SHARED_LIBRARY) return NextResponse.json({ ok: false, error: "Only shared creative assets have brand tags" }, { status: 403 });
    const next = mergeBrandTags(asset.allowedBrandSlugs || [], requested, mine);
    const response = await fetch(`${apiBaseUrl}/assets/bulk-update`, {
      method: "POST",
      headers: await connectKeyHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ assetIds: [assetId], metadata: { allowedBrandSlugs: next } }),
      cache: "no-store"
    });
    if (!response.ok) return NextResponse.json({ ok: false, error: "The asset could not be updated" }, { status: 502 });
    return NextResponse.json({ ok: true, brands: next });
  } catch {
    return NextResponse.json({ ok: false, error: "Asset not found" }, { status: 404 });
  }
}
