import { NextRequest, NextResponse } from "next/server";
import { threadsSignedRequest } from "../signed-request";
export const runtime = "nodejs";

// Meta pings this when a Threads user removes Elettro OS. Their token stops working on its own;
// the log line is the cue to clear the brand's Threads row on the Connections page.
export async function POST(request: NextRequest) {
  const data = await threadsSignedRequest(request);
  if (!data?.user_id) return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });
  console.info("[threads] app removed by Threads user", data.user_id);
  return NextResponse.json({ ok: true });
}
