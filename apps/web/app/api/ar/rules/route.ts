import { arWriteRoute } from "@/lib/ar-write";
import { ruleFields } from "@/lib/ar-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// First actions for a cover: which actions fire, in order, when it is scanned.
export const POST = (request: Request) => arWriteRoute(request, "rules", undefined, ruleFields);
