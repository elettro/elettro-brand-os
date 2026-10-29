import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, serverSetting } from "@/lib/cognito-auth";
import { BLUESKY_BRANDS, BLUESKY_STATE_COOKIE, blueskyClient, decryptState } from "@/lib/bluesky-connect";
import type { NodeSavedState } from "@atproto/oauth-client-node";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "bluesky", ...params }));
  response.cookies.delete(BLUESKY_STATE_COOKIE);
  return response;
}

// The account's current handle, from its own PDS (the token set only carries the DID).
async function handleOf(pds: string, did: string): Promise<string | null> {
  const r = await fetch(`${pds}/xrpc/com.atproto.repo.describeRepo?${new URLSearchParams({ repo: did })}`, { cache: "no-store" });
  const body = await r.json().catch(() => ({})) as { handle?: string };
  return r.ok && body.handle ? body.handle : null;
}

export async function GET(request: NextRequest) {
  const sealed = await decryptState(request.cookies.get(BLUESKY_STATE_COOKIE)?.value);
  let saved: { brand?: string; states?: Array<[string, NodeSavedState]> } = {};
  try { saved = JSON.parse(sealed || "{}"); } catch { /* treated as an expired link below */ }
  const brand = saved.brand || "";
  if (!BLUESKY_BRANDS.includes(brand) || !saved.states?.length) return done({ error: "The connect link expired; try again" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Bluesky access was not granted" : denied });
  try {
    const { client, sessions } = await blueskyClient(new Map(saved.states));
    const { session } = await client.callback(request.nextUrl.searchParams);
    const did = session.did;
    const saved1 = sessions.get(did);
    if (!saved1) throw Error("Bluesky returned no session");
    // The library hands back a URL with a trailing slash; the API and the publisher want the bare origin.
    const pds = new URL(String(saved1.tokenSet.aud)).origin;
    const handle = await handleOf(pds, did);
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/bluesky/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, account: { did, handle, pds }, session: saved1 }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: handle ? "@" + handle : did, ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("Bluesky connect callback failed", error instanceof Error ? error.message : "UnknownError");
    return done({ brand, error: "Elettro OS could not finish the Bluesky connection" });
  }
}
