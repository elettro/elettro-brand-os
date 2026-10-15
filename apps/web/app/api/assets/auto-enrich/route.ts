import { NextRequest, NextResponse } from "next/server";
import { authenticated, DEV_ORIGIN } from "@/lib/cognito-auth";
import { GatewayError } from "@/lib/ai-gateway";
import { enrichMissingAssetMetadata } from "@/lib/asset-ai-enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (process.env.AWS_BRANCH && process.env.AWS_BRANCH !== "develop")
    return NextResponse.json({ ok: false, error: "DEV only" }, { status: 404 });
  if (!(await authenticated()))
    return NextResponse.json({ ok: false, error: "Login required" }, { status: 401 });
  if (request.headers.get("origin") !== DEV_ORIGIN)
    return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  if (!(request.headers.get("content-type") || "").startsWith("application/json"))
    return NextResponse.json({ ok: false, error: "Expected application/json" }, { status: 415 });

  let input: { brandSlug?: unknown; assetId?: unknown };
  try {
    const raw = await request.text();
    if (raw.length > 1024) throw Error("Body too large");
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid input");
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }
  try {
    const result = await enrichMissingAssetMetadata({ brandSlug: input.brandSlug, assetId: input.assetId });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GatewayError)
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    console.error("EPE auto enrichment failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Visual enrichment unavailable; asset registration is unaffected" }, { status: 503 });
  }
}
