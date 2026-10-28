import { serverSetting } from "@/lib/cognito-auth";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Brands that appear on the Review page: the Connect Meta brands, plus Neckermann Strom (no Meta login yet, but it has posts to review).
import { META_BRANDS } from "@/lib/meta-connect";
export const REVIEW_BRANDS = [...META_BRANDS, "neckermann-strom", "google-review"];

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
export type ReviewAccount = { socialAccountId: string; destination: string; accountName: string; externalAccountId: string | null; publishingMode: string; placement: string | null; postsPerWeek: number | null; active: boolean | null };
// live: approved posts auto-publish · planning: planned, publisher not built · review: waiting on the network's app review
// · integration: not connected to Elettro OS yet (never editable). The list comes from the API (publishing-formats.mjs).
export type PublishingFormat = { destination: string; placement: string; label: string; status: "live" | "planning" | "review" | "integration"; note?: string;
  // Carousel formats: the network's hard limits and the advisory best range of images.
  slides?: { min: number; max: number; recommended: [number, number] } };
export type ReviewList = {
  ok: boolean; error?: string; brand: string; timeZone: string; weekStart: string; weeks: number; destinations: string[]; approvedWeeks?: string[];
  hasPlannerSettings: boolean; accounts: ReviewAccount[]; posts: ReviewPost[]; formats: PublishingFormat[]; maxPostsPerWeek: number;
  slideRanges?: Record<string, { min: number; max: number } | null>;
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
