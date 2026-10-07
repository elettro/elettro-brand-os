import { NextResponse } from "next/server";
import { brandConfigs } from "@/lib/brand-config";

export async function GET() {
  return NextResponse.json({ brands: brandConfigs });
}
