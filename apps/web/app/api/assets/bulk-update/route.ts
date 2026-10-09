import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DEV_API_BASE_URL = "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  DEFAULT_DEV_API_BASE_URL;

export async function POST(request: NextRequest) {
  const body = await request.text();

  const response = await fetch(`${apiBaseUrl}/assets/bulk-update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store"
  });

  const text = await response.text();

  return new NextResponse(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json" }
  });
}
