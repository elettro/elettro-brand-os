import { NextRequest, NextResponse } from "next/server";
import { authenticated, DEV_ORIGIN } from "@/lib/cognito-auth";
import { executeAiGateway, GatewayError } from "@/lib/ai-gateway";
import { batchUpdateAssetMetadata } from "@/lib/ai-gateway-batch";
import { runMetadataWriteSmokeTest } from "@/lib/ai-gateway-write-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY = 64 * 1024;

/**
 * Owner-session API for initial dashboard testing.
 * This is NOT yet a publicly connectable MCP endpoint.
 * The future ChatGPT/Claude OAuth adapter must call executeAiGateway only
 * after validating the operator, requested brand scope, and operation grant.
 */
export async function POST(request: NextRequest) {
  if (process.env.AWS_BRANCH && process.env.AWS_BRANCH !== "develop")
    return NextResponse.json({ ok: false, error: "AI Gateway is DEV-only" }, { status: 404 });
  if (!(await authenticated()))
    return NextResponse.json({ ok: false, error: "Login required" }, { status: 401 });
  if (request.headers.get("origin") !== DEV_ORIGIN)
    return NextResponse.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  if (!(request.headers.get("content-type") || "").startsWith("application/json"))
    return NextResponse.json({ ok: false, error: "Expected application/json" }, { status: 415 });
  if (Number(request.headers.get("content-length") || "0") > MAX_BODY)
    return NextResponse.json({ ok: false, error: "Request too large" }, { status: 413 });

  const raw = await request.text();
  if (raw.length > MAX_BODY)
    return NextResponse.json({ ok: false, error: "Request too large" }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  try {
    const action = typeof input === "object" && input && "action" in input ? (input as { action?: unknown }).action : undefined;
    const result = action === "batch_update_asset_metadata"
      ? await batchUpdateAssetMetadata(input)
      : action === "test_metadata_round_trip"
        ? await runMetadataWriteSmokeTest(input)
        : await executeAiGateway(input);
    if (typeof input === "object" && input && "action" in input) {
      const action = String((input as { action: unknown }).action);
      if (action !== "search_assets" && action !== "get_asset" && action !== "list_folders" && action !== "capabilities") {
        console.info("Elettro AI Gateway owner action", action, "completed");
      }
    }
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof GatewayError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    console.error("AI Gateway action failed", error instanceof Error ? error.name : "Unknown");
    return NextResponse.json({ ok: false, error: "AI Gateway operation unavailable" }, { status: 503 });
  }
}
