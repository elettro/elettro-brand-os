import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { META_CALLBACK, META_GRAPH_VERSION, META_STATE_COOKIE, type MetaPage, pickPage } from "@/lib/meta-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const graph = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(META_STATE_COOKIE);
  return response;
}

async function graphGet<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
  const response = await fetch(`${graph}/${path}?${new URLSearchParams(params)}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok || body.error) throw Error(`Meta ${what} failed: ${body.error?.message || response.status}`);
  return body;
}

// Meta calls happen here: the dev-api Lambda runs in a VPC without internet egress.
// Code → short-lived user token → 60-day user token; Page tokens read with the 60-day token do not expire.
async function longLivedUserToken(code: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/meta-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  const short = await graphGet<{ access_token?: string }>("oauth/access_token",
    { client_id: clientId, client_secret: clientSecret, redirect_uri: META_CALLBACK, code }, "code exchange");
  const long = await graphGet<{ access_token?: string }>("oauth/access_token",
    { grant_type: "fb_exchange_token", client_id: clientId, client_secret: clientSecret, fb_exchange_token: short.access_token || "" }, "token exchange");
  if (!long.access_token) throw Error("Meta returned no access token");
  return long.access_token;
}

async function grantedPages(userToken: string) {
  const body = await graphGet<{ data?: MetaPage[] }>("me/accounts",
    { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "200", access_token: userToken }, "Page lookup");
  return body.data || [];
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(META_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Facebook access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Facebook sent no code" });
  try {
    const page = pickPage(await grantedPages(await longLivedUserToken(code)), brand);
    if (!page.access_token) throw Error("Meta returned no Page token; make sure Elettro OS may manage the Page");
    const ig = page.instagram_business_account;
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/meta/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({
        brand,
        page: { id: page.id, name: page.name },
        pageToken: page.access_token,
        instagram: ig ? { id: ig.id, username: ig.username || null } : null
      }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: ig?.username ? `${page.name} + @${ig.username}` : page.name, network: "meta" });
  } catch (error) {
    console.error("Meta connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^(Meta|Facebook)/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
