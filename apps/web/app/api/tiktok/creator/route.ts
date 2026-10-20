import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { authenticated } from "@/lib/cognito-auth";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
export const runtime = "nodejs";

const lambda = new LambdaClient({ region: "us-east-1" });
const WORKER = process.env.TIKTOK_WORKER_FUNCTION || "elettro-brand-os-dev-tiktok";

// The Review page's TikTok card: TikTok wants the account name, avatar and the allowed privacy and
// interaction settings read fresh from creator_info whenever the creator is about to approve a post.
// The token lives with the TikTok worker, so the worker asks TikTok.
export async function GET(request: NextRequest) {
  if (!(await authenticated())) return NextResponse.json({ ok: false, error: "Log in to Elettro OS first" }, { status: 401 });
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!TIKTOK_BRANDS.includes(brand)) return NextResponse.json({ ok: false, error: "Unknown brand" }, { status: 400 });
  try {
    const response = await lambda.send(new InvokeCommand({ FunctionName: WORKER, Payload: Buffer.from(JSON.stringify({ action: "creator-info", brand })) }));
    const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}") as { statusCode?: number; ok?: boolean; error?: string };
    if (response.FunctionError || !out.ok) return NextResponse.json({ ok: false, error: out.error || "TikTok account lookup failed" }, { status: 502 });
    const { statusCode: _, ...info } = out;
    return NextResponse.json(info, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("TikTok creator info failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ ok: false, error: "Elettro OS could not reach the TikTok worker" }, { status: 502 });
  }
}
