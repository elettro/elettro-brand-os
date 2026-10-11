import { NextRequest, NextResponse } from "next/server";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export const runtime = "nodejs";

const ssm = new SSMClient({ region: "us-east-1" });
const DEV_UPLOAD_PARAMETER = "/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/DROPBOX_UPLOAD_API_SHARED_SECRET";

async function getUploadKey(): Promise<string | undefined> {
  if (process.env.DROPBOX_UPLOAD_API_SHARED_SECRET) return process.env.DROPBOX_UPLOAD_API_SHARED_SECRET;
  if (process.env.AWS_BRANCH && process.env.AWS_BRANCH !== "develop") return undefined;
  const result = await ssm.send(new GetParameterCommand({ Name: DEV_UPLOAD_PARAMETER, WithDecryption: true }));
  return result.Parameter?.Value;
}


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
  let uploadKey: string | undefined;
  if (uploadSession && uploadApi) {
    try {
      uploadKey = await getUploadKey();
    } catch (error) {
      console.error("Dropbox upload secret retrieval failed", error instanceof Error ? error.name : "UnknownError");
      return NextResponse.json({ ok: false, error: "Dropbox upload server authentication is unavailable" }, { status: 503 });
    }
  }
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
