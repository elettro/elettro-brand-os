import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, serverSetting, unseal } from "@/lib/cognito-auth";
import { SNAPCHAT_BRANDS, SNAPCHAT_CALLBACK, SNAPCHAT_PROFILE_URL, SNAPCHAT_STATE_COOKIE, SNAPCHAT_TOKEN_URL, snapchatApp } from "@/lib/snapchat-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "snapchat", ...params }));
  response.cookies.delete(SNAPCHAT_STATE_COOKIE);
  return response;
}

// Snap calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function exchange(code: string) {
  const app = await snapchatApp();
  const response = await fetch(SNAPCHAT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: SNAPCHAT_CALLBACK }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!response.ok || body.error || !body.access_token || !body.refresh_token) {
    throw Error(`Snapchat code exchange failed: ${body.error_description || body.error || response.status}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
}

async function profile(accessToken: string) {
  const response = await fetch(SNAPCHAT_PROFILE_URL, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as {
    display_message?: string; debug_message?: string;
    public_profile?: { id?: string; display_name?: string; snap_user_name?: string };
  };
  const p = body.public_profile;
  if (!response.ok || !p?.id) {
    throw Error(`Snapchat profile lookup failed: ${body.display_message || body.debug_message || response.status}. The login needs a Snapchat Public Profile and an allowlisted app.`);
  }
  return { id: p.id, displayName: p.display_name || null, username: p.snap_user_name || null };
}

export async function GET(request: NextRequest) {
  const sealed = await unseal(request.cookies.get(SNAPCHAT_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state") || !SNAPCHAT_BRANDS.includes(brand)) return done({ error: "The connect link expired; try again" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Snapchat access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code") || "";
  if (!code) return done({ brand, error: "Snapchat sent no code" });
  let step = "code exchange";
  try {
    const tokens = await exchange(code);
    step = "profile lookup";
    const who = await profile(tokens.accessToken);
    step = "reading the connect key";
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    step = "saving the connection";
    const response = await fetch(`${apiBaseUrl}/connections/snapchat/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, profile: who, ...tokens }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: who.username ? "@" + who.username : who.displayName || who.id });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "UnknownError";
    console.error(`Snapchat connect callback failed at ${step}: ${detail}`);
    const message = error instanceof Error && /^Snapchat/.test(error.message) ? error.message : `Elettro OS could not finish the connection (${step}: ${error instanceof Error ? error.name : "error"})`;
    return done({ brand, error: message });
  }
}
