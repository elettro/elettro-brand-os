import { arWriteRoute } from "@/lib/ar-write";
import { coverFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rename a cover or nudge its placement (x, y, size). The tracking image itself is never changed here.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return arWriteRoute(request, "triggers", id, coverFields);
}
