import { NextResponse } from "next/server";
import { blueskyClient } from "@/lib/bluesky-connect";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public by design: Bluesky's servers fetch this to learn what "Elettro OS" is. It is the OAuth app registration.
export async function GET() {
  try {
    const { client } = await blueskyClient();
    return NextResponse.json(client.clientMetadata, { headers: { "cache-control": "public, max-age=300" } });
  } catch (error) {
    console.error("Bluesky client metadata failed", error instanceof Error ? error.message : "UnknownError");
    return NextResponse.json({ error: "Bluesky client is not configured" }, { status: 503 });
  }
}
