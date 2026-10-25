import { connectKeyHeaders } from "@/lib/dev-api-key";
import type { ApiAsset } from "@/lib/dev-api";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Server components only: calls the dev-api directly with the connect key. Browser code uses lib/dev-api.ts (via /api/dev-api).
async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: await connectKeyHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error(`Brand OS API request failed: ${response.status} ${path}`);
  return response.json() as Promise<T>;
}

export async function getAssets() {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>("/assets");
}

export async function getAsset(id: string) {
  return fetchJson<{ ok: boolean; asset: ApiAsset }>(`/assets?id=${encodeURIComponent(id)}`);
}

export async function getContentPool() {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>("/content-pool");
}
