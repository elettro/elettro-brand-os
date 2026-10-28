import { arWriteRoute } from "@/lib/ar-write";
import { ruleFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Replace the actions (and their order) for a cover that already has a rule.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return arWriteRoute(request, "rules", id, ruleFields);
}
