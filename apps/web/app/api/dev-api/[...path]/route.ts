import { NextRequest, NextResponse } from "next/server";
import { authenticated } from "@/lib/cognito-auth";
import { connectKeyHeaders } from "@/lib/dev-api-key";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Read-only dev-api routes the browser may fetch through the signed-in web app (the dev-api itself needs the connect key).
const ALLOWED = new Set(["brands", "dashboard", "assets", "content-pool", "dropbox/thumbnail"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await authenticated())) return NextResponse.json({ ok: false, error: "Login required" }, { status: 401 });
  const { path } = await params;
  const route = path.join("/");
  if (!ALLOWED.has(route)) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  try {
    const upstream = await fetch(`${apiBaseUrl}/${route}${request.nextUrl.search}`, {
      headers: await connectKeyHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(25000)
    });
    const headers = new Headers({ "cache-control": route === "dropbox/thumbnail" ? "private, max-age=300" : "no-store" });
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Elettro API did not answer" }, { status: 502 });
  }
}
