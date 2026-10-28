import { NextResponse } from "next/server";
import { session } from "@/lib/cognito-auth";
import { canAccessBrand } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arCall, ArNotConfigured } from "@/lib/ar-api";

// Shared by the AR write routes: the caller must be signed in and allowed to see that brand (owner or a client of it).
// The AR API itself refuses writes for a brand with AR switched off and validates every field.
export async function arWriteRoute(request: Request, collection: string, id?: string, fields?: (body: unknown) => Record<string, unknown>, opts: { suffix?: string } = {}) {
  const who = await session();
  if (!who) return NextResponse.json({ ok: false, error: "Sign in first" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { brand?: unknown } | null;
  const brand = typeof body?.brand === "string" ? body.brand : "";
  if (!brandConfigs.some((b) => b.id === brand) || !canAccessBrand(who, brand)) {
    return NextResponse.json({ ok: false, error: "Pick one of your brands" }, { status: 403 });
  }
  try {
    const path = `/ar/brands/${encodeURIComponent(brand)}/${collection}${id ? "/" + encodeURIComponent(id) : ""}${opts.suffix || ""}`;
    const data = await arCall<{ item?: unknown }>(path, { method: id && !opts.suffix ? "PATCH" : "POST", body: fields ? fields(body) : body, actor: who.email });
    return NextResponse.json({ ok: true, item: data.item, ...(opts.suffix ? data : {}) });
  } catch (error) {
    if (error instanceof ArNotConfigured) return NextResponse.json({ ok: false, error: "AR is not connected to this environment yet" }, { status: 502 });
    const problems = (error as { problems?: string[] }).problems;
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "The AR service did not accept that", ...(problems ? { problems } : {}) }, { status: 400 });
  }
}
