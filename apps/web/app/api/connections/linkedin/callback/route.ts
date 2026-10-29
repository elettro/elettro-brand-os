import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticatedFor, cookieSettings, seal, serverSetting, unseal } from "@/lib/cognito-auth";
import { LINKEDIN_CALLBACK, LINKEDIN_PAGE_BRANDS, LINKEDIN_PICK_COOKIE, LINKEDIN_STATE_COOKIE } from "@/lib/linkedin-connect";
import { adminPages, completePageConnect, pagesTokenFor } from "@/lib/linkedin-pages";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  const response = NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams(params) + "#linkedin");
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

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A login that administers several pages: pick which one belongs to this brand. The tokens wait in a signed, httpOnly cookie.
async function pickerPage(brand: string, pages: Array<{ id: string; name: string }>, token: unknown) {
  const options = pages.map((p) => `<label style="display:block;margin:10px 0"><input type="radio" name="page" value="${escapeHtml(p.id)}" required> ${escapeHtml(p.name)}</label>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Pick the LinkedIn page</title>
<body style="font:16px system-ui;max-width:520px;margin:48px auto;padding:0 16px;background:#0c0c0c;color:#eee">
<h1 style="font-size:22px">Which LinkedIn page is ${escapeHtml(brand)}?</h1>
<p>Your login administers several pages. Pick the one Elettro OS should post to for this brand.</p>
<form method="post" action="/api/connections/linkedin/pick">${options}<button style="margin-top:16px;padding:10px 18px;font-size:16px">Connect this page</button></form>
<p><a style="color:#9cf" href="/connections#linkedin">Cancel</a></p></body>`;
  const response = new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  response.cookies.set(LINKEDIN_PICK_COOKIE, await seal(JSON.stringify({ brand, pages, token })), cookieSettings(600));
  response.cookies.delete(LINKEDIN_STATE_COOKIE);
  return response;
}

async function connectPage(brand: string, code: string) {
  if (!LINKEDIN_PAGE_BRANDS.includes(brand)) return done({ brand, error: "That brand has no LinkedIn company page" });
  const token = await pagesTokenFor(code);
  const pages = await adminPages(token.accessToken);
  if (!pages.length) return done({ brand, error: "This LinkedIn login does not administer any company page" });
  if (pages.length > 1) return pickerPage(brand, pages, token);
  const result = await completePageConnect(brand, pages[0], token);
  return done({ brand, connected: pages[0].name, network: "linkedin", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
}

export async function GET(request: NextRequest) {
  const sealed = await unseal(request.cookies.get(LINKEDIN_STATE_COOKIE)?.value);
  const [state, brand, kind] = (sealed || "").split("|");
  if (!(await authenticatedFor(brand || ""))) return done({ error: "Log in to Elettro OS first" });
  if (!state || state !== request.nextUrl.searchParams.get("state")) return done({ error: "The connect link expired; try again" });
  const denied = request.nextUrl.searchParams.get("error");
  if (denied) return done({ brand, error: denied === "user_cancelled_authorize" || denied === "user_cancelled_login" ? "LinkedIn access was not granted" : denied });
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return done({ brand, error: "LinkedIn sent no code" });
  try {
    if (kind === "page") return await connectPage(brand, code);
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
