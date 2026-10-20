import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({ region: "us-east-1" });
const WORKER = process.env.TIKTOK_WORKER_FUNCTION || "elettro-brand-os-dev-tiktok";

// The TikTok worker holds the tokens and talks to TikTok (services/tiktok-lambda); the web app asks it.
export async function tiktokWorker<T>(payload: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  const response = await lambda.send(new InvokeCommand({ FunctionName: WORKER, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}") as T & { statusCode?: number; ok?: boolean; error?: string };
  if (response.FunctionError) return { ...out, ok: false, error: "The TikTok worker crashed" };
  const { statusCode: _, ...body } = out;
  return { ...body, ok: Boolean(out.ok) } as T & { ok: boolean; error?: string };
}
