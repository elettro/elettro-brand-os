import { NextResponse } from "next/server";
import { mockAssets } from "@/lib/mock-assets";

export async function GET() {
  const assets = mockAssets.filter((asset) => asset.approval === "approved" && asset.status === "ready");
  return NextResponse.json({ assets });
}
