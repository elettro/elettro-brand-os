import { arWriteRoute } from "@/lib/ar-write";
import { setFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rename a set or change which covers it holds (the slug never changes).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return arWriteRoute(request, "sets", id, setFields);
}
