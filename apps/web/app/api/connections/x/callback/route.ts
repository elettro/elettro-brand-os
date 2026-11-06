import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, serverSetting, unseal } from "@/lib/cognito-auth";
import { X_BRANDS, X_CALLBACK, X_STATE_COOKIE, xApp, xBasicAuth } from "@/lib/x-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "x", ...params }) + "#x");
  response.cookies.delete(X_STATE_COOKIE);
  return response;
}

// X calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function xToken(code: string, verifier: string) {
  const app = await xApp();
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: xBasicAuth(app) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: X_CALLBACK, client_id: app.clientId, code_verifier: verifier }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || !token.access_token) throw Error(`X rejected the code: ${token.error_description || token.error || response.status}`);
  return token;
}

async function account(accessToken: string) {
  const response = await fetch("https://api.x.com/2/users/me", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { data?: { id?: string; username?: string }; detail?: string; title?: string };
  if (!response.ok || !body.data?.id || !body.data?.username) throw Error(`X profile lookup failed: ${body.detail || body.title || response.status}`);
  return { id: body.data.id, username: body.data.username };
}

export async function GET(request: NextRequest) {
  const sealed = await unseal(request.cookies.get(X_STATE_COOKIE)?.value);
  const [state, brand, verifier] = (sealed || "").split("|");
  if (!state || !verifier || state !== request.nextUrl.searchParams.get("state") || !X_BRANDS.includes(brand)) return done({ error: "The connect link expired; try again" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "X access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "X sent no code" });
  try {
    const token = await xToken(code, verifier);
    const who = await account(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/x/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({
        brand, account: who, accessToken: token.access_token, refreshToken: token.refresh_token, scope: token.scope,
        expiresAt: new Date(Date.now() + (token.expires_in || 7200) * 1000).toISOString()
      }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; account?: { username?: string } };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: `@${result.account?.username || who.username}` });
  } catch (error) {
    console.error("X connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^X /.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
