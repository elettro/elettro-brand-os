import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { GBP_CALLBACK, GBP_LOCATION_TITLES, GBP_STATE_COOKIE } from "@/lib/gbp-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(GBP_STATE_COOKIE);
  return response;
}

// Google calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function googleTokens(code: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/google-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: GBP_CALLBACK, client_id: clientId, client_secret: clientSecret }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!response.ok) throw Error(`Google rejected the code: ${token.error || response.status}`);
  if (!token.refresh_token) throw Error("Google returned no refresh token; remove Elettro OS from the account's third-party access and connect again");
  return token;
}

async function googleGet<T>(url: string, accessToken: string, what: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw Error(`Google ${what} failed: ${body.error?.message || response.status}`);
  return body;
}

// Every profile the signed-in Google account manages, across all of its business accounts.
async function managedLocations(accessToken: string) {
  const accounts = await googleGet<{ accounts?: Array<{ name: string }> }>("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", accessToken, "account lookup");
  const found: Array<{ id: string; title: string }> = [];
  for (const account of accounts.accounts || []) {
    let pageToken = "";
    do {
      const query = new URLSearchParams({ readMask: "name,title", pageSize: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const page = await googleGet<{ locations?: Array<{ name: string; title?: string }>; nextPageToken?: string }>(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?${query}`, accessToken, "profile lookup");
      // The Business Information API returns names as locations/<id>; the account prefix makes the id usable by the posting API.
      for (const location of page.locations || []) found.push({ id: `${account.name}/${location.name}`, title: location.title || location.name });
      pageToken = page.nextPageToken || "";
    } while (pageToken);
  }
  return found;
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(GBP_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Google access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Google sent no code" });
  const pattern = GBP_LOCATION_TITLES[brand];
  if (!pattern) return done({ brand, error: "Unknown brand" });
  try {
    const token = await googleTokens(code);
    const locations = await managedLocations(token.access_token || "");
    const matches = locations.filter((l) => pattern.test(l.title));
    if (matches.length !== 1) {
      const titles = locations.map((l) => l.title).join(", ") || "none";
      throw Error(matches.length
        ? `Google found ${matches.length} profiles matching ${brand} (${matches.map((l) => l.title).join(", ")}); narrow the match`
        : `Google found no profile for ${brand} on that account (it manages: ${titles})`);
    }
    const location = matches[0];
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/gmb/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, location, refreshToken: token.refresh_token, scope: token.scope }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: location.title });
  } catch (error) {
    console.error("GBP connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Google/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
