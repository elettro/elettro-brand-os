import { NextResponse } from "next/server";
import { authenticated } from "@/lib/cognito-auth";
export const runtime="nodejs";
export async function GET() {
  return NextResponse.json({authenticated:await authenticated()},{headers:{"cache-control":"no-store"}});
}
