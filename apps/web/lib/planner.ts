import { serverSetting } from "@/lib/cognito-auth";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

export type CadenceRule = {
  id: string;
  destination: string;
  accountName: string;
  publishingMode: string;
  connected: boolean;
  placement: string;
  postsPerWeek: number;
  preferredDays: string[];
  preferredStartTime: string | null;
  preferredEndTime: string | null;
};

export type PlannedPost = {
  id: string;
  scheduledFor: string;
  status: string;
  placement: string;
  destination: string;
  filename: string;
  title: string | null;
  url: string | null;
  error: string | null;
};

export type PlannerWeek = {
  ok: boolean;
  error?: string;
  brand: string;
  timeZone: string;
  weekStart: string;
  rules: CadenceRule[];
  posts: PlannedPost[];
  replanRequested: boolean;
};

// Server-only: the dev API's /planner route takes the same owner key as the connect flow.
export async function plannerCall<T = PlannerWeek>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/planner`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-elettro-connect-key": await serverSetting("CONNECTIONS_API_SHARED_SECRET") },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({ ok: false, error: `Planner API returned ${response.status}` }));
  return result as T;
}

export type StatCounts = {
  possible: number; scheduled: number; awaiting: number; failed: number;
  today: number; week: number; month: number; total: number;
};
export type NetworkStats = {
  destination: string;
  label: string;
  connectedBrands: number;
  totals: StatCounts;
  formats: Array<StatCounts & { placement: string; label: string; status: string; note: string | null }>;
};
export type DashboardStats = {
  ok: boolean;
  error?: string;
  scope: string;
  generatedAt: string;
  brands: Array<{ slug: string; name: string }>;
  networks: NetworkStats[];
};
