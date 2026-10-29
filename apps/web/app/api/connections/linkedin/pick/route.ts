import { NextRequest, NextResponse } from "next/server";
import { allowedOrigin, authenticatedFor, unseal } from "@/lib/cognito-auth";
import { LINKEDIN_PICK_COOKIE } from "@/lib/linkedin-connect";
import { completePageConnect, connectionsUrl, type AdminPage, type PageToken } from "@/lib/linkedin-pages";
export const runtime = "nodejs";

// Finishes a company-page connect when the login administers several pages and the user chose one.
export async function POST(request: NextRequest) {
  const finish = (params: Record<string, string>) => {
    // 303 so the browser follows the form POST with a GET.
    const response = NextResponse.redirect(connectionsUrl(params), 303);
    response.cookies.delete(LINKEDIN_PICK_COOKIE);
    return response;
  };
  if (!allowedOrigin(request.headers.get("origin"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const sealed = await unseal(request.cookies.get(LINKEDIN_PICK_COOKIE)?.value);
  if (!sealed) return finish({ error: "The page choice expired; connect again" });
  const { brand, pages, token } = JSON.parse(sealed) as { brand: string; pages: AdminPage[]; token: PageToken };
  if (!(await authenticatedFor(brand))) return finish({ error: "Log in to Elettro OS first" });
  const chosen = String((await request.formData()).get("page") || "");
  const page = pages.find((p) => p.id === chosen);
  if (!page) return finish({ brand, error: "Pick one of the listed pages" });
  try {
    const result = await completePageConnect(brand, page, token);
    return finish({ brand, connected: page.name, network: "linkedin", ...(result.expiresAt ? { expires: result.expiresAt } : {}) });
  } catch (error) {
    console.error("LinkedIn page pick failed", error instanceof Error ? error.name : "UnknownError");
    return finish({ brand, error: error instanceof Error && /^LinkedIn/.test(error.message) ? error.message : "Elettro OS could not finish the connection" });
  }
}
