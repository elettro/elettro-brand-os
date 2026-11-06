import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, serverSetting, unseal } from "@/lib/cognito-auth";
import { REDDIT_BRANDS, REDDIT_CALLBACK, REDDIT_STATE_COOKIE, REDDIT_USER_AGENT, redditApp, redditBasicAuth } from "@/lib/reddit-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "reddit", ...params }) + "#reddit");
  response.cookies.delete(REDDIT_STATE_COOKIE);
  return response;
}

// Reddit calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function redditToken(code: string) {
  const app = await redditApp();
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: redditBasicAuth(app), "user-agent": REDDIT_USER_AGENT },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDDIT_CALLBACK }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!response.ok || !token.access_token) throw Error(`Reddit rejected the code: ${token.error || response.status}`);
  return token;
}

async function account(accessToken: string) {
  const response = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": REDDIT_USER_AGENT }, cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as { id?: string; name?: string; message?: string };
  if (!response.ok || !body.id || !body.name) throw Error(`Reddit profile lookup failed: ${body.message || response.status}`);
  return { id: body.id, username: body.name };
}

export async function GET(request: NextRequest) {
  const sealed = await unseal(request.cookies.get(REDDIT_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state") || !REDDIT_BRANDS.includes(brand)) return done({ error: "The connect link expired; try again" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Reddit access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Reddit sent no code" });
  try {
    const token = await redditToken(code);
    const who = await account(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/reddit/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({
        brand, account: who, accessToken: token.access_token, refreshToken: token.refresh_token, scope: token.scope,
        expiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString()
      }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; account?: { username?: string } };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: `u/${result.account?.username || who.username}` });
  } catch (error) {
    console.error("Reddit connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Reddit /.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
