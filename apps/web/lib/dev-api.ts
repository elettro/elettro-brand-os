const DEFAULT_DEV_API_BASE_URL = "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  DEFAULT_DEV_API_BASE_URL;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Brand OS API request failed: ${response.status} ${path}`);
  }

  return response.json() as Promise<T>;
}

export type ApiBrand = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
};

export type DashboardMetrics = {
  brands: number;
  dropboxAccounts: number;
  assetsIndexed: number;
  approvedInPool: number;
};

export type ApiAsset = {
  id: string;
  filename: string;
  kind: string;
  sourceType?: string;
  sourcePath?: string | null;
  fileSizeBytes?: string | number | null;
  ingestStatus?: string;
  enrichmentStatus?: string;
  approvalStatus?: string;
  contentGroup?: string | null;
  topic?: string | null;
  aspectRatioLabel?: string | null;
  eligibilityType?: string;
  priority?: string;
  brandSlug: string;
  brandName: string;
  createdAt?: string;
};

export async function getBrands() {
  return fetchJson<{ ok: boolean; brands: ApiBrand[] }>("/brands");
}

export async function getDashboard() {
  return fetchJson<{ ok: boolean; dashboard: DashboardMetrics }>("/dashboard");
}

export async function getAssets() {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>("/assets");
}

export async function getContentPool() {
  return fetchJson<{ ok: boolean; assets: ApiAsset[] }>("/content-pool");
}


export function getAssetThumbnailUrl(sourcePath?: string | null) {
  if (!sourcePath) return null;
  return `${apiBaseUrl}/dropbox/thumbnail?path=${encodeURIComponent(sourcePath)}`;
}
