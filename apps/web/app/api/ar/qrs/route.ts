import { arWriteRoute } from "@/lib/ar-write";
import { qrFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a QR code for one of the caller's brands.
export const POST = (request: Request) => arWriteRoute(request, "qrs", undefined, qrFields);
