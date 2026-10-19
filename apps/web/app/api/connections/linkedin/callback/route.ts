import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { LINKEDIN_CALLBACK, LINKEDIN_STATE_COOKIE } from "@/lib/linkedin-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(LINKEDIN_STATE_COOKIE);
  return response;
}

// LinkedIn calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function linkedinToken(code: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/linkedin-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: LINKEDIN_CALLBACK, client_id: clientId, client_secret: clientSecret }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || !token.access_token) throw Error(`LinkedIn rejected the code: ${token.error_description || token.error || response.status}`);
  return token;
}

async function member(accessToken: string) {
  const response = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { sub?: string; name?: string; message?: string };
  if (!response.ok || !body.sub) throw Error(`LinkedIn profile lookup failed: ${body.message || response.status}`);
  return { id: body.sub, name: body.name || body.sub };
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(LINKEDIN_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "user_cancelled_authorize" || denied === "user_cancelled_login" ? "LinkedIn access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "LinkedIn sent no code" });
  try {
    const token = await linkedinToken(code);
    const who = await member(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/linkedin/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, member: who, accessToken: token.access_token, expiresIn: token.expires_in, scope: token.scope }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: who.name, network: "linkedin", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("LinkedIn connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^LinkedIn/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
