import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "elettro-brand-os-web",
    sprint: 1
  });
}
