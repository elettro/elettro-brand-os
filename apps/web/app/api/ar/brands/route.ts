import { NextResponse } from "next/server";
import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arBrand, ArNotConfigured } from "@/lib/ar-api";
import { arBrandsFor } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Which brands this session may open in the AR section. The owner always sees the section (to switch AR on);
// a client sees it only when one of their own brands has AR enabled, and never learns about other brands.
export async function GET() {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Sign in first" }, { status: 401 });
  if (who.owner) return NextResponse.json({ ok: true, owner: true, brands: visibleBrands(who, brandConfigs).map((b) => b.id) });
  const ids = visibleBrands(who, brandConfigs).map((b) => b.id);
  const enabled: Record<string, boolean> = {};
  try {
    await Promise.all(ids.map(async (id) => {
      try { enabled[id] = (await arBrand(id)).entitlement?.arEnabled === true; } catch { enabled[id] = false; }
    }));
  } catch (error) {
    if (!(error instanceof ArNotConfigured)) throw error;
  }
  return NextResponse.json({ ok: true, owner: false, brands: arBrandsFor(who, ids, enabled) }, { headers: { "cache-control": "no-store" } });
}
