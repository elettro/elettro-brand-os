import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticatedFor, allowedOrigin } from "@/lib/cognito-auth";
import { X_BRANDS, X_POST_LIMIT, X_TOKEN_PREFIX, freshXToken, type XAccountTokens } from "@/lib/x-connect";
export const runtime = "nodejs";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  // 303 so the browser follows the form POST with a GET.
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "x", ...params }) + "#x", 303);
}

// Tokens are stored per X account; pick the one connected for this brand.
async function brandToken(brand: string): Promise<{ name: string; token: XAccountTokens } | null> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [X_TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(X_TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as XAccountTokens;
    if (token.brand === brand && token.accessToken) return { name: entry.Name, token };
  }
  return null;
}

// "Post to X now" from the Connections page: a text-only post Dean writes and sends himself.
export async function POST(request: NextRequest) {
  // Same-origin form only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  const text = String(form.get("text") || "").trim();
  if (!X_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  if (!text || text.length > X_POST_LIMIT) return done({ brand, error: `Write 1 to ${X_POST_LIMIT} characters` });
  try {
    const found = await brandToken(brand);
    if (!found) return done({ brand, error: "Connect X first" });
    const accessToken = await freshXToken(found.name, found.token);
    // X has no idempotency key; it refuses an exact repeat of a recent post, which covers a double click.
    const response = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
      cache: "no-store"
    });
    const body = await response.json().catch(() => ({})) as { data?: { id?: string }; detail?: string; title?: string };
    if (!response.ok || !body.data?.id) return done({ brand, error: `X refused the post: ${body.detail || body.title || response.status}` });
    return done({ brand, posted: `https://x.com/${found.token.username}/status/${body.data.id}` });
  } catch (error) {
    console.error("X test post failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^X /.test(error.message) ? error.message : "Elettro OS could not send the post";
    return done({ brand, error: message });
  }
}
