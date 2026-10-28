import { arWriteRoute } from "@/lib/ar-write";
import { setFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Create a scan set for one of the caller's brands.
export const POST = (request: Request) => arWriteRoute(request, "sets", undefined, setFields);
