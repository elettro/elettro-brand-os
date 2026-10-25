import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticated, allowedOrigin } from "@/lib/cognito-auth";
import { LINKEDIN_API_VERSION, LINKEDIN_BRANDS, littleText } from "@/lib/linkedin-connect";
export const runtime = "nodejs";

const secrets = new SecretsManagerClient({ region: "us-east-1" });
const TOKEN_PREFIX = "elettro-brand-os-dev/linkedin/";

type MemberToken = { accessToken: string; memberUrn: string; brand: string; expiresAt: string };

function done(params: Record<string, string>) {
  // 303 so the browser follows the form POST with a GET.
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "linkedin", ...params }) + "#linkedin", 303);
}

// Member tokens are stored per LinkedIn member id; pick the one connected for this brand.
async function brandToken(brand: string): Promise<MemberToken | null> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as MemberToken;
    if (token.brand === brand && token.accessToken) return token;
  }
  return null;
}

// "Post to LinkedIn now" from the Connections page: a text-only post Dean writes and sends himself.
export async function POST(request: NextRequest) {
  // Same-origin form only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!(await authenticated())) return done({ error: "Log in to Elettro OS first" });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  const text = String(form.get("text") || "").trim();
  if (!LINKEDIN_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!text || text.length > 3000) return done({ brand, error: "Write 1 to 3,000 characters" });
  try {
    const token = await brandToken(brand);
    if (!token) return done({ brand, error: "Connect LinkedIn first" });
    if (Date.parse(token.expiresAt) <= Date.now()) return done({ brand, error: "The LinkedIn login has expired; reconnect first" });
    const response = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        "linkedin-version": LINKEDIN_API_VERSION,
        "x-restli-protocol-version": "2.0.0"
      },
      body: JSON.stringify({
        author: token.memberUrn,
        commentary: littleText(text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false
      }),
      cache: "no-store"
    });
    if (response.status !== 201) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      return done({ brand, error: `LinkedIn refused the post: ${body.message || response.status}` });
    }
    const urn = response.headers.get("x-restli-id") || "";
    return done({ brand, posted: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "https://www.linkedin.com/in/me/recent-activity/all/" });
  } catch (error) {
    console.error("LinkedIn test post failed", error instanceof Error ? error.name : "UnknownError");
    return done({ brand, error: "Elettro OS could not send the post" });
  }
}
