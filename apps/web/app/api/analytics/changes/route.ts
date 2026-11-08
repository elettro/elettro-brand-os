import { NextRequest, NextResponse } from "next/server";
import { allowedOrigin, authenticated, session } from "@/lib/cognito-auth";
import { reviewCall } from "@/lib/planner-review";
import { ANALYTICS_BRANDS } from "@/lib/analytics";
export const runtime = "nodejs";

// Changes for next week (planner-changes.mjs): owner only, same origin only. Decisions are recorded with the signed-in email.
const ACTIONS = ["changes", "changes-refresh", "change-decide"];

export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  if (!(await authenticated())) return NextResponse.json({ ok: false, error: "Owner only" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { brand?: string; action?: string; id?: string; decision?: string };
  const brand = String(body.brand || "");
  const action = String(body.action || "");
  if (!ANALYTICS_BRANDS.includes(brand) || !ACTIONS.includes(action)) return NextResponse.json({ ok: false, error: "Unknown brand or action" }, { status: 400 });
  const who = await session();
  const r = await reviewCall({ brand, action, id: body.id, decision: body.decision, by: who?.email || "owner" });
  return NextResponse.json(r.data, { status: r.status });
}
