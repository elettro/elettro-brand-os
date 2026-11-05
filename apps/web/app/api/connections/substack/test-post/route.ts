import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticatedFor, allowedOrigin } from "@/lib/cognito-auth";
import { SUBSTACK_BODY_LIMIT, SUBSTACK_BRANDS, SUBSTACK_SECRET_PREFIX, SUBSTACK_TITLE_LIMIT, substackPublish } from "@/lib/substack-connect";
export const runtime = "nodejs";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

type Login = { cookie: string; subdomain: string; userId: string; brand: string };

function done(params: Record<string, string>) {
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "substack", ...params }) + "#substack", 303);
}

// Logins are stored per publication; pick the one connected for this brand.
async function brandLogin(brand: string): Promise<Login | null> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [SUBSTACK_SECRET_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(SUBSTACK_SECRET_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const login = JSON.parse(value.SecretString || "{}") as Login;
    if (login.brand === brand && login.cookie) return login;
  }
  return null;
}

// "Post to Substack now" from the Connections page: a text post Dean writes and sends himself. Goes live on the web, never emailed.
export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  const title = String(form.get("title") || "").trim();
  const text = String(form.get("text") || "").trim();
  if (!SUBSTACK_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  if (!title || title.length > SUBSTACK_TITLE_LIMIT) return done({ brand, error: `Write a title of 1 to ${SUBSTACK_TITLE_LIMIT} characters` });
  if (!text || text.length > SUBSTACK_BODY_LIMIT) return done({ brand, error: `Write 1 to ${SUBSTACK_BODY_LIMIT} characters of text` });
  try {
    const login = await brandLogin(brand);
    if (!login) return done({ brand, error: "Connect Substack first" });
    const url = await substackPublish(login.cookie, login.subdomain, login.userId, title, text);
    return done({ brand, posted: url });
  } catch (error) {
    console.error("Substack test post failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Substack/.test(error.message) ? error.message : "Elettro OS could not send the post";
    return done({ brand, error: message });
  }
}
