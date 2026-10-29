import { NextResponse } from "next/server";
import { blueskyClient } from "@/lib/bluesky-connect";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public keys only (the private key never leaves Secrets Manager). Bluesky uses these to verify our token requests.
export async function GET() {
  try {
    const { client } = await blueskyClient();
    return NextResponse.json(client.jwks, { headers: { "cache-control": "public, max-age=300" } });
  } catch (error) {
    console.error("Bluesky jwks failed", error instanceof Error ? error.message : "UnknownError");
    return NextResponse.json({ error: "Bluesky client is not configured" }, { status: 503 });
  }
}
