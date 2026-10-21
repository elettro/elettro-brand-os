import { serverSetting } from "@/lib/cognito-auth";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Brands whose Facebook + Instagram posts can be reviewed (same list as Connect Meta).
export { META_BRANDS as REVIEW_BRANDS } from "@/lib/meta-connect";

export type TiktokSettings = { privacyLevel: string; allowComment: boolean; allowDuet: boolean; allowStitch: boolean; yourBrand: boolean; brandedContent: boolean };
export type TiktokCreator = {
  username: string | null; nickname: string | null; avatarUrl: string | null; privacyLevelOptions: string[];
  commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxVideoPostDurationSec: number | null;
};
export type ReviewAsset = { id: string; filename: string; kind: string; sourcePath: string | null; title: string | null; durationMs: number | null };
export type ReviewPost = {
  id: string; destination: string; accountName: string; placement: string; scheduledFor: string; status: string;
  title: string | null; caption: string | null; hashtags: string[]; reason: string | null; sector: string | null;
  copyStatus: string | null; captionStale: boolean; asset: ReviewAsset; candidates: ReviewAsset[];
  tiktok: TiktokSettings | null;
};
export type ReviewAccount = { destination: string; accountName: string; externalAccountId: string | null; publishingMode: string; placement: string | null; postsPerWeek: number | null; active: boolean | null };
export type ReviewList = {
  ok: boolean; error?: string; brand: string; timeZone: string; weekStart: string; weeks: number; destinations: string[]; approvedWeeks?: string[];
  hasPlannerSettings: boolean; accounts: ReviewAccount[]; posts: ReviewPost[];
};

// Server-side only: forwards one review action to the dev API with the shared connect key.
export async function reviewCall<T = { ok: boolean; error?: string }>(body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
  const response = await fetch(`${apiBaseUrl}/planner/review`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-elettro-connect-key": key },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({ ok: false, error: `Review API returned HTTP ${response.status}` })) as T;
  return { status: response.status, data };
}
