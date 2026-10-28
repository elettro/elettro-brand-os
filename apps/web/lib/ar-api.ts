import { connectKeyHeaders } from "@/lib/dev-api-key";
import type { ArDoc } from "@/lib/ar-access";

// Server-only: the AR admin API (services/ar-lambda) answers only callers holding the shared connect key,
// exactly like the dev-api. Never call it from browser code.
export const AR_PUBLIC_BASE = process.env.AR_PUBLIC_BASE_URL || "https://ar.elettro.com";

export class ArNotConfigured extends Error {
  constructor() { super("AR_API_BASE_URL is not set for this environment"); }
}

function apiBase(): string {
  const base = process.env.AR_API_BASE_URL;
  if (!base) throw new ArNotConfigured();
  return base.replace(/\/+$/, "");
}

export async function arCall<T>(path: string, init: { method?: string; body?: unknown; actor?: string } = {}): Promise<T> {
  const headers = await connectKeyHeaders(init.actor ? { "x-elettro-actor": init.actor } : {});
  const response = await fetch(apiBase() + path, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(8000)
  });
  const data = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; problems?: string[] };
  if (!response.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || `AR API answered ${response.status}`), { status: response.status, problems: data.problems });
  }
  return data;
}

export const arBrand = (brand: string) => arCall<ArDoc & { ok: true; brand: string }>(`/ar/brands/${encodeURIComponent(brand)}`);

export const arSetEnabled = (brand: string, enabled: boolean, actor: string) =>
  arCall(`/ar/brands/${encodeURIComponent(brand)}/entitlement`, { method: "PUT", body: { arEnabled: enabled }, actor });
