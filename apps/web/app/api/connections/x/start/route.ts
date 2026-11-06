import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { authenticatedFor, challenge, cookieSettings, seal } from "@/lib/cognito-auth";
import { X_BRANDS, X_CALLBACK, X_SCOPES, X_STATE_COOKIE, xApp } from "@/lib/x-connect";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "";
  if (!X_BRANDS.includes(brand)) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  if (!(await authenticatedFor(brand))) return NextResponse.redirect(new URL("/api/auth/login", request.url));
  try {
    const app = await xApp();
    const state = challenge();
    // PKCE: the verifier stays in the signed, HttpOnly cookie; only its hash goes to X.
    const verifier = randomBytes(48).toString("base64url");
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", X_CALLBACK);
    url.searchParams.set("scope", X_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    const response = NextResponse.redirect(url);
    response.cookies.set(X_STATE_COOKIE, await seal([state, brand, verifier].join("|")), cookieSettings(600));
    return response;
  } catch (error) {
    console.error("X connect start failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.redirect(new URL("/connections?" + new URLSearchParams({ brand, network: "x", error: "X is not set up yet" }) + "#x", request.url));
  }
}
