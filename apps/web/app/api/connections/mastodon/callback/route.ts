import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, serverSetting, unseal } from "@/lib/cognito-auth";
import { MASTODON_BRANDS, MASTODON_CALLBACK, MASTODON_SCOPES, MASTODON_STATE_COOKIE, mastodonApp } from "@/lib/mastodon-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params) + "#mastodon");
  response.cookies.delete(MASTODON_STATE_COOKIE);
  return response;
}

// Mastodon calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function mastodonToken(instance: string, clientId: string, clientSecret: string, code: string) {
  const response = await fetch(`https://${instance}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: MASTODON_CALLBACK, client_id: clientId, client_secret: clientSecret,
      scope: MASTODON_SCOPES.join(" ")
    }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!response.ok || !token.access_token) throw Error(`Mastodon rejected the code: ${token.error_description || token.error || response.status}`);
  return token;
}

async function account(instance: string, accessToken: string) {
  const response = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { id?: string; acct?: string; error?: string };
  if (!response.ok || !body.id || !body.acct) throw Error(`Mastodon profile lookup failed: ${body.error || response.status}`);
  return { id: body.id, acct: body.acct, instance };
}

export async function GET(request: NextRequest) {
  const sealed = await unseal(request.cookies.get(MASTODON_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state") || !MASTODON_BRANDS.includes(brand)) return done({ error: "The connect link expired; try again" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Mastodon access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Mastodon sent no code" });
  try {
    const app = await mastodonApp();
    const token = await mastodonToken(app.instance, app.clientId, app.clientSecret, code);
    const who = await account(app.instance, token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/mastodon/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, account: who, accessToken: token.access_token, scope: token.scope }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; account?: { acct?: string } };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: `@${result.account?.acct || who.acct}`, network: "mastodon" });
  } catch (error) {
    console.error("Mastodon connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Mastodon/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
