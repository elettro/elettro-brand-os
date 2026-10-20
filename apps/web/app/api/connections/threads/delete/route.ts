import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { threadsSignedRequest } from "../signed-request";
export const runtime = "nodejs";

// Meta's data-deletion callback: answer with a status URL and a confirmation code.
// Deletion itself follows the 30-day promise at elettro.com/privacy/#data-deletion.
export async function POST(request: NextRequest) {
  const data = await threadsSignedRequest(request);
  if (!data?.user_id) return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });
  const confirmation_code = randomUUID();
  console.info("[threads] data deletion requested", data.user_id, confirmation_code);
  return NextResponse.json({ url: "https://elettro.com/privacy/#data-deletion", confirmation_code });
}
