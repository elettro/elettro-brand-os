import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { TIKTOK_CALLBACK, TIKTOK_STATE_COOKIE, tiktokApp } from "@/lib/tiktok-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const api = "https://open.tiktokapis.com/v2";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(TIKTOK_STATE_COOKIE);
  return response;
}

type Token = {
  access_token?: string; expires_in?: number; refresh_token?: string; refresh_expires_in?: number;
  open_id?: string; scope?: string; error?: string; error_description?: string;
};

// TikTok calls happen here: the dev-api Lambda runs in a VPC without internet egress.
// Code → 24-hour access token + 365-day refresh token (each refresh returns a new pair).
async function exchangeCode(code: string): Promise<Token> {
  const { clientKey, clientSecret } = await tiktokApp();
  const response = await fetch(`${api}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: TIKTOK_CALLBACK }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as Token;
  if (!response.ok || body.error || !body.access_token || !body.open_id) {
    throw Error(`TikTok code exchange failed: ${body.error_description || body.error || response.status}`);
  }
  return body;
}

async function profile(accessToken: string, openId: string) {
  const response = await fetch(`${api}/user/info/?fields=open_id,username,display_name`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as {
    data?: { user?: { open_id?: string; username?: string; display_name?: string } }; error?: { code?: string; message?: string };
  };
  if (!response.ok || (body.error?.code && body.error.code !== "ok")) {
    throw Error(`TikTok profile lookup failed: ${body.error?.message || body.error?.code || response.status}`);
  }
  const user = body.data?.user || {};
  return { id: user.open_id || openId, username: user.username || null, name: user.display_name || null };
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(TIKTOK_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "TikTok access was not granted" : request.nextUrl.searchParams.get("error_description") || denied });
  const code = request.nextUrl.searchParams.get("code") || "";
  if (!code) return done({ brand, error: "TikTok sent no code" });
  try {
    const token = await exchangeCode(code);
    const who = await profile(token.access_token || "", token.open_id || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/tiktok/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({
        brand, user: who, accessToken: token.access_token, expiresIn: token.expires_in,
        refreshToken: token.refresh_token, refreshExpiresIn: token.refresh_expires_in, scope: token.scope
      }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: who.username ? "@" + who.username : who.name || who.id, network: "tiktok", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("TikTok connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^TikTok/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
