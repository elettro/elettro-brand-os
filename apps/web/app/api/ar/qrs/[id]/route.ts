import { arWriteRoute } from "@/lib/ar-write";
import { qrFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Repoint or rename one QR code. The slug (and so the printed address) never changes.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return arWriteRoute(request, "qrs", id, qrFields);
}
