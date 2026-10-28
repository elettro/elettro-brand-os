import { NextResponse } from "next/server";
import { session } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { arSetEnabled, ArNotConfigured } from "@/lib/ar-api";
import { canToggleAr } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner only: switch AR on or off for one brand. The AR API rewrites that brand's public manifest
// (a disabled brand serves a "not active" stub), so this is a live change.
export async function PUT(request: Request) {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Sign in first" }, { status: 401 });
  if (!canToggleAr(who)) return NextResponse.json({ ok: false, error: "Only the owner can switch AR on or off" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { brand?: unknown; enabled?: unknown } | null;
  const brand = typeof body?.brand === "string" ? body.brand : "";
  if (!brandConfigs.some((b) => b.id === brand) || typeof body?.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "Send { brand, enabled } for a real brand" }, { status: 400 });
  }
  try {
    await arSetEnabled(brand, body.enabled, who.email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof ArNotConfigured ? "AR is not connected to this environment yet" : "The AR service did not accept that change";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
