import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, serverSetting, unseal } from "@/lib/cognito-auth";
import { YOUTUBE_CALLBACK, YOUTUBE_STATE_COOKIE } from "@/lib/youtube-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params));
  response.cookies.delete(YOUTUBE_STATE_COOKIE);
  return response;
}

// Google calls happen here: the dev-api Lambda runs in a VPC without internet egress.
async function googleTokens(code: string) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/google-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: YOUTUBE_CALLBACK, client_id: clientId, client_secret: clientSecret }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!response.ok) throw Error(`Google rejected the code: ${token.error || response.status}`);
  if (!token.refresh_token) throw Error("Google returned no refresh token; remove Elettro OS from the account's third-party access and connect again");
  return token;
}

async function pickedChannel(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string } }>; error?: { message?: string } };
  if (!response.ok) throw Error(`YouTube channel lookup failed: ${body.error?.message || response.status}`);
  const channel = body.items?.[0];
  if (!channel) throw Error("That Google account has no YouTube channel; pick the channel when Google asks");
  return { id: channel.id, title: channel.snippet?.title || channel.id, handle: channel.snippet?.customUrl || null };
}

export async function GET(request: NextRequest) {
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const sealed = await unseal(request.cookies.get(YOUTUBE_STATE_COOKIE)?.value);
  const [state, brand] = (sealed || "").split("|");
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "access_denied" ? "Google access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "Google sent no code" });
  try {
    const token = await googleTokens(code);
    const channel = await pickedChannel(token.access_token || "");
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/youtube/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, channel, refreshToken: token.refresh_token, scope: token.scope }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: channel.handle || channel.title });
  } catch (error) {
    console.error("YouTube connect callback failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^(Google|YouTube|That Google)/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
