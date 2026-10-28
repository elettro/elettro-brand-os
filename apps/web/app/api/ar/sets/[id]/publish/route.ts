import { arWriteRoute } from "@/lib/ar-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Publish a set: its images and videos become public at ar.elettro.com. The AR API returns a plain list of
// problems (a video never uploaded, a cover with no action, ...) instead of publishing when anything is missing.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return arWriteRoute(request, "sets", id, () => ({}), { suffix: "/publish" });
}
