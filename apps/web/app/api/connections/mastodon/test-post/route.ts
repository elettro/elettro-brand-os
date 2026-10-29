import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticatedFor, allowedOrigin } from "@/lib/cognito-auth";
import { MASTODON_BRANDS, MASTODON_POST_LIMIT } from "@/lib/mastodon-connect";
export const runtime = "nodejs";

const secrets = new SecretsManagerClient({ region: "us-east-1" });
const TOKEN_PREFIX = "elettro-brand-os-dev/mastodon/";

type AccountToken = { accessToken: string; instance: string; acct: string; brand: string };

function done(params: Record<string, string>) {
  // 303 so the browser follows the form POST with a GET.
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "mastodon", ...params }) + "#mastodon", 303);
}

// Tokens are stored per Mastodon account; pick the one connected for this brand.
async function brandToken(brand: string): Promise<AccountToken | null> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as AccountToken;
    if (token.brand === brand && token.accessToken) return token;
  }
  return null;
}

// "Post to Mastodon now" from the Connections page: a text-only public post Dean writes and sends himself.
export async function POST(request: NextRequest) {
  // Same-origin form only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  const text = String(form.get("text") || "").trim();
  if (!MASTODON_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  if (!text || text.length > MASTODON_POST_LIMIT) return done({ brand, error: `Write 1 to ${MASTODON_POST_LIMIT} characters` });
  try {
    const token = await brandToken(brand);
    if (!token) return done({ brand, error: "Connect Mastodon first" });
    const response = await fetch(`https://${token.instance}/api/v1/statuses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        // A repeated click can't publish twice.
        "idempotency-key": randomUUID()
      },
      body: JSON.stringify({ status: text, visibility: "public" }),
      cache: "no-store"
    });
    const body = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !body.url) return done({ brand, error: `Mastodon refused the post: ${body.error || response.status}` });
    return done({ brand, posted: body.url });
  } catch (error) {
    console.error("Mastodon test post failed", error instanceof Error ? error.name : "UnknownError");
    return done({ brand, error: "Elettro OS could not send the post" });
  }
}
