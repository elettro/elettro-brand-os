import { NextRequest, NextResponse } from "next/server";
import { DEV_ORIGIN, authenticatedFor, allowedOrigin, serverSetting } from "@/lib/cognito-auth";
import { SUBSTACK_BRANDS, cookieHeader, parseSubdomain, substackProfile } from "@/lib/substack-connect";
export const runtime = "nodejs";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

function done(params: Record<string, string>) {
  // 303 so the browser follows the form POST with a GET.
  return NextResponse.redirect(DEV_ORIGIN + "/connections?" + new URLSearchParams({ network: "substack", ...params }) + "#substack", 303);
}

// "Connect Substack": the owner pastes the publication address and the substack.sid cookie of a logged-in account.
// The cookie is checked against Substack here (the dev-api has no internet egress), then stored by the dev-api in Secrets Manager.
export async function POST(request: NextRequest) {
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const brand = String(form.get("brand") || "");
  if (!SUBSTACK_BRANDS.includes(brand)) return done({ error: "Unknown brand" });
  if (!(await authenticatedFor(brand))) return done({ error: "Log in to Elettro OS first" });
  const subdomain = parseSubdomain(String(form.get("publication") || ""));
  const cookie = cookieHeader(String(form.get("cookie") || ""));
  if (!subdomain) return done({ brand, error: "Enter the publication address, for example yourname.substack.com" });
  if (!cookie) return done({ brand, error: "Paste the substack.sid cookie value" });
  try {
    const profile = await substackProfile(cookie);
    if (profile.publications && !profile.publications.includes(subdomain)) {
      return done({ brand, error: `That login is not a member of ${subdomain}.substack.com` });
    }
    const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
    const response = await fetch(`${apiBaseUrl}/connections/substack/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-elettro-connect-key": key },
      body: JSON.stringify({ brand, subdomain, userId: profile.userId, handle: profile.handle, cookie }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; account?: { publication?: string } };
    if (!response.ok || !result.ok) return done({ brand, error: result.error || `Connect failed (HTTP ${response.status})` });
    return done({ brand, connected: result.account?.publication || `${subdomain}.substack.com` });
  } catch (error) {
    console.error("Substack connect failed", error instanceof Error ? error.name : "UnknownError");
    const message = error instanceof Error && /^Substack/.test(error.message) ? error.message : "Elettro OS could not finish the connection";
    return done({ brand, error: message });
  }
}
