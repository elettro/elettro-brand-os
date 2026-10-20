import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { THREADS_APP_ID, THREADS_CALLBACK, THREADS_OAUTH_SECRET, THREADS_STATE_COOKIE } from "@/lib/threads-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const graph = "https://graph.threads.net";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(THREADS_STATE_COOKIE);
  return response;
}

async function threadsJson<T>(response: Response, what: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string }; error_message?: string };
  if (!response.ok || body.error) throw Error(`Threads ${what} failed: ${body.error?.message || body.error_message || response.status}`);
  return body;
}

// Threads calls happen here: the dev-api Lambda runs in a VPC without internet egress.
// Code → 1-hour token → 60-day token (refreshable with th_refresh_token before it lapses).
async function longLivedToken(code: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: THREADS_OAUTH_SECRET }));
  // The Threads app ID is public, so it comes from code; only the app secret is read from Secrets Manager.
  const { clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientSecret?: string };
  if (!clientSecret) throw Error(`Threads app secret missing: ${THREADS_OAUTH_SECRET} needs a "clientSecret" key`);
  const clientId = THREADS_APP_ID;
  const short = await threadsJson<{ access_token?: string }>(await fetch(`${graph}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: THREADS_CALLBACK, code }),
    cache: "no-store"
  }), "code exchange");
  const long = await threadsJson<{ access_token?: string; expires_in?: number }>(await fetch(`${graph}/access_token?${new URLSearchParams({
    grant_type: "th_exchange_token", client_secret: clientSecret, access_token: short.access_token || ""
  })}`, { cache: "no-store" }), "token exchange");
  if (!long.access_token) throw Error("Threads returned no access token");
  return long;
}

async function profile(accessToken: string) {
  const body = await threadsJson<{ id?: string; username?: string; name?: string }>(await fetch(`${graph}/v1.0/me?${new URLSearchParams({
    fields: "id,username,name", access_token: accessToken
  })}`, { cache: "no-store" }), "profile lookup");
  if (!body.id) throw Error("Threads profile lookup returned no id");
  return { id: body.id, username: body.username || null, name: body.name || null };
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(THREADS_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Threads access was not granted" : denied });
  // Threads appends "#_" to the code in some redirects.
  const code = (request.nextUrl.searchParams.get("code") || "").replace(/#_$/, "");
  if (!code) return done({ brand, error: "Threads sent no code" });
  try {
    const token = await longLivedToken(code);
    const who = await profile(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/threads/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, user: who, accessToken: token.access_token, expiresIn: token.expires_in }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: who.username ? "@" + who.username : who.id, network: "threads", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("Threads connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Threads/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
