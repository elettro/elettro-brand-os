import { NextRequest, NextResponse } from "next/server";

const DEFAULT_DEV_API_BASE_URL = "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  DEFAULT_DEV_API_BASE_URL;

export async function POST(request: NextRequest) {
  const body = await request.text();

  let action = "";
  try { action = String(JSON.parse(body)?.action || ""); } catch { /* Existing API handles invalid JSON. */ }
  const uploadSession = ["start-dropbox-upload-session", "append-dropbox-upload-session", "finish-dropbox-upload-session"].includes(action);
  const uploadApi = process.env.DROPBOX_UPLOAD_API_URL;
  const uploadKey = process.env.DROPBOX_UPLOAD_API_SHARED_SECRET;
  if (uploadSession && (!uploadApi || !uploadKey)) {
    return NextResponse.json({ ok: false, error: "Dedicated Dropbox upload API is not configured" }, { status: 503 });
  }
  const response = await fetch(uploadSession ? uploadApi! : `${apiBaseUrl}/assets/bulk-update`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(uploadSession ? { "x-elettro-upload-key": uploadKey! } : {}) },
    body,
    cache: "no-store"
  });

  const text = await response.text();

  return new NextResponse(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json" }
  });
}
