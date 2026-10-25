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

// `brands` limits a call to those brands (a client account); null/undefined means everything (the owner).
// A scoped asset list also includes the shared creative-assets library.
function scoped(brands: string[] | null | undefined, shared = false): string {
  if (!brands) return "";
  return `brands=${encodeURIComponent(brands.join(","))}${shared ? "&shared=1" : ""}`;
}

export async function getAssets(brands?: string[] | null) {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>(`/assets${brands ? "?" + scoped(brands, true) : ""}`);
}

export async function getAsset(id: string, brands?: string[] | null) {
  return fetchJson<{ ok: boolean; asset: ApiAsset }>(`/assets?id=${encodeURIComponent(id)}${brands ? "&" + scoped(brands, true) : ""}`);
}

export async function getContentPool(brands?: string[] | null) {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>(`/content-pool${brands ? "?" + scoped(brands) : ""}`);
}
