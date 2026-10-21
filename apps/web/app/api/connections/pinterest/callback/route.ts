import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { PINTEREST_APP_ID, PINTEREST_CALLBACK, PINTEREST_OAUTH_SECRET, PINTEREST_STATE_COOKIE } from "@/lib/pinterest-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const api = "https://api.pinterest.com/v5";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(PINTEREST_STATE_COOKIE);
  return response;
}

type Token = {
  access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number;
  scope?: string; code?: number; message?: string;
};

// Pinterest calls happen here: the dev-api Lambda runs in a VPC without internet egress.
// Code → 30-day access token + refresh token (continuous refresh: each refresh extends it).
async function exchangeCode(code: string): Promise<Token> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: PINTEREST_OAUTH_SECRET }));
  // The app ID is public, so it comes from code; only the app secret is read from Secrets Manager.
  const { clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientSecret?: string };
  if (!clientSecret) throw Error(`Pinterest app secret missing: ${PINTEREST_OAUTH_SECRET} needs a "clientSecret" key`);
  const response = await fetch(`${api}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${PINTEREST_APP_ID}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: PINTEREST_CALLBACK, continuous_refresh: "true" }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as Token;
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw Error(`Pinterest code exchange failed: ${body.message || response.status}`);
  }
  return body;
}

// Brands already sharing this account's token, so a second brand's connect keeps the first one.
async function connectedBrands(userId: string): Promise<string[]> {
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: `elettro-brand-os-dev/pinterest/${userId}` }));
    const record = JSON.parse(secret.SecretString || "{}") as { brand?: string; brands?: string[] };
    return [...(record.brands || []), ...(record.brand ? [record.brand] : [])];
  } catch {
    return [];
  }
}

async function profile(accessToken: string) {
  const response = await fetch(`${api}/user_account`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { id?: string; username?: string; business_name?: string; message?: string };
  if (!response.ok || !body.username) throw Error(`Pinterest profile lookup failed: ${body.message || response.status}`);
  return { id: body.id || body.username, username: body.username, name: body.business_name || null };
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(PINTEREST_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Pinterest access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code") || "";
  if (!code) return done({ brand, error: "Pinterest sent no code" });
  try {
    const token = await exchangeCode(code);
    const who = await profile(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/pinterest/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({
        brand, brands: await connectedBrands(who.id), user: who, accessToken: token.access_token, expiresIn: token.expires_in,
        refreshToken: token.refresh_token, refreshExpiresIn: token.refresh_token_expires_in, scope: token.scope
      }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: "@" + who.username, network: "pinterest", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("Pinterest connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Pinterest/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
