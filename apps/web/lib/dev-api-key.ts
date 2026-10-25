import { serverSetting } from "@/lib/cognito-auth";

// Server-only: the dev API answers every route except /status/* only to callers holding the shared connect key.
export async function connectKeyHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { ...extra, "x-elettro-connect-key": await serverSetting("CONNECTIONS_API_SHARED_SECRET") };
}
