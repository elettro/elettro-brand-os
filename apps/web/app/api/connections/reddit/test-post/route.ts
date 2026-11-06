import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, authenticatedFor, allowedOrigin } from "@/lib/cognito-auth";
import { REDDIT_BRANDS, REDDIT_TEXT_LIMIT, REDDIT_TITLE_LIMIT, REDDIT_TOKEN_PREFIX, REDDIT_USER_AGENT, freshRedditToken, type RedditAccountTokens } from "@/lib/reddit-connect";
export const runtime = "nodejs";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

function done(params: Record<string, string>) {
  // 303 so the browser follows the form POST with a GET.
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "reddit", ...params }) + "#reddit", 303);
}

// Tokens are stored per Reddit account; pick the one connected for this brand.
async function brandToken(brand: string): Promise<{ name: string; token: RedditAccountTokens } | null> {
  const listed = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [REDDIT_TOKEN_PREFIX] }] }));
  for (const entry of listed.SecretList || []) {
    if (!entry.Name?.startsWith(REDDIT_TOKEN_PREFIX)) continue;
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: entry.Name }));
    const token = JSON.parse(value.SecretString || "{}") as RedditAccountTokens;
    if (token.brand === brand && token.accessToken) return { name: entry.Name, token };
  }
  return null;
}

// "u/name" -> "u_name", "r/name" -> "name", plain names pass through. Empty means the brand's own profile.
export function redditTarget(raw: string) {
  const value = raw.trim();
  const user = /^\/?u\/(.+)$/i.exec(value);
  if (user) return "u_" + user[1];
  const sub = /^\/?r\/(.+)$/i.exec(value);
  return sub ? sub[1] : value;
}

// "Post to Reddit now" from the Connections page: a text post Dean writes and sends himself, to the brand's own profile
// (u_<name>) unless he types a subreddit he controls.
export async function POST(request: NextRequest) {
  // Same-origin form only, so another site can't post on Dean's behalf with his session cookie.
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  const title = String(form.get("title") || "").trim();
  const text = String(form.get("text") || "").trim();
  const target = redditTarget(String(form.get("target") || ""));
  if (!REDDIT_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  if (!title || title.length > REDDIT_TITLE_LIMIT) return done({ brand, error: `Write a title of 1 to ${REDDIT_TITLE_LIMIT} characters` });
  if (text.length > REDDIT_TEXT_LIMIT) return done({ brand, error: `Keep the text under ${REDDIT_TEXT_LIMIT} characters` });
  if (target && !/^[A-Za-z0-9_-]{2,24}$/.test(target)) return done({ brand, error: "Target must be a subreddit name or u/<username>" });
  try {
    const found = await brandToken(brand);
    if (!found) return done({ brand, error: "Connect Reddit first" });
    const accessToken = await freshRedditToken(found.name, found.token);
    const sr = target || `u_${found.token.username}`;
    const response = await fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded", "user-agent": REDDIT_USER_AGENT },
      body: new URLSearchParams({ api_type: "json", kind: "self", sr, title, text, resubmit: "false", sendreplies: "false" }),
      cache: "no-store"
    });
    const body = await response.json().catch(() => ({})) as { json?: { errors?: string[][]; data?: { url?: string } } };
    const errors = body.json?.errors || [];
    if (!response.ok || errors.length || !body.json?.data?.url) {
      return done({ brand, error: `Reddit refused the post: ${errors.map((e) => e.slice(0, 2).join(": ")).join("; ") || response.status}` });
    }
    return done({ brand, posted: body.json.data.url });
  } catch (error) {
    console.error("Reddit test post failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Reddit /.test(error.message) ? error.message : "Elettro OS could not send the post";
    return done({ brand, error: message });
  }
}
