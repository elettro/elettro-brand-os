import { serverSetting } from "@/lib/cognito-auth";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

// Brands that appear on the Review page: the Connect Meta brands, plus Neckermann Strom (no Meta login yet, but it has posts to review).
import { META_BRANDS } from "@/lib/meta-connect";
export const REVIEW_BRANDS = [...META_BRANDS, "google-review"];

// Holidays tab: the seven brands with pictures (Google Review is dormant; Dean Palermo, Rompe and Reggae.Land skipped on request). A brand with no database row simply shows nothing.
export const HOLIDAY_BRANDS = ["stashbox", "elettro", "solarmeister", "neckermann-strom", "weightlossdavie", "therasbox", "pianomusicsoothing"];
export const HOLIDAYS = [
  { key: "halloween", name: "Halloween", label: "Oct 31" },
  { key: "christmas", name: "Weihnachten", label: "Dec 24" }
];
// Holidays that only some brands have pictures for (Christmas is German: SolarMeister and Neckermann Strom).
export const HOLIDAY_ONLY_BRANDS: Record<string, string[]> = { christmas: ["solarmeister", "neckermann-strom"] };
export type HolidayDraft = {
  id: string; status: "draft" | "skipped" | "approved"; caption: string; hashtags: string[]; imageName: string; imageReady: boolean; asset: ReviewAsset | null;
  posts: Array<{ id: string; status: string; destination: string; accountName: string; scheduledFor: string }>;
};
export type HolidayList = { ok: boolean; error?: string; brand: string; holiday: string; name: string; date: string; timeZone: string; destinations: string[]; drafts: HolidayDraft[]; choices: ReviewAsset[] };

export type TiktokSettings = { privacyLevel: string; allowComment: boolean; allowDuet: boolean; allowStitch: boolean; yourBrand: boolean; brandedContent: boolean };
export type TiktokCreator = {
  username: string | null; nickname: string | null; avatarUrl: string | null; privacyLevelOptions: string[];
  commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxVideoPostDurationSec: number | null;
};
export type ReviewAsset = { id: string; filename: string; kind: string; sourcePath: string | null; title: string | null; durationMs: number | null };
// A hand-written LinkedIn text, link or poll post (the details the writer saved; a poll or link has no media of its own).
export type ReviewCustom = { kind: "text" | "link" | "poll"; question?: string; options?: string[]; duration?: string; url?: string; title?: string; description?: string };
export type ReviewPost = {
  id: string; destination: string; accountName: string; placement: string; scheduledFor: string; status: string;
  title: string | null; caption: string | null; hashtags: string[]; reason: string | null; sector: string | null;
  copyStatus: string | null; captionStale: boolean; asset: ReviewAsset; candidates: ReviewAsset[];
  tiktok: TiktokSettings | null; failureReason: string | null; custom?: ReviewCustom | null;
};
export type ReviewAccount = { socialAccountId: string; destination: string; accountName: string; externalAccountId: string | null; publishingMode: string; placement: string | null; postsPerWeek: number | null; active: boolean | null };
// live: approved posts auto-publish · planning: planned, publisher not built · review: waiting on the network's app review
// · integration: not connected to Elettro OS yet (never editable). The list comes from the API (publishing-formats.mjs).
export type PublishingFormat = { destination: string; placement: string; label: string; status: "live" | "planning" | "review" | "integration"; note?: string;
  // Carousel formats: the network's hard limits and the advisory best range of images.
  slides?: { min: number; max: number; recommended: [number, number] };
  // GMB: Review stores a posts-per-week target (at most maxPostsPerWeek) although the format is not planned yet.
  savesCadence?: boolean; maxPostsPerWeek?: number;
  // "week": Review opens this format's box per week (slow formats such as Substack galleries); "gallery" etc. replaces the word "carousel" in its image-count label.
  defaultUnit?: "week"; slidesNoun?: string };
export type ReviewList = {
  ok: boolean; error?: string; brand: string; timeZone: string; weekStart: string; weeks: number; destinations: string[]; approvedWeeks?: string[];
  hasPlannerSettings: boolean; accounts: ReviewAccount[]; posts: ReviewPost[]; formats: PublishingFormat[]; maxPostsPerWeek: number;
  slideRanges?: Record<string, { min: number; max: number } | null>;
  // Live planning status per week (plan-runs.mjs): one entry per network while a Plan click or the planner tick runs.
  planStatus?: Record<string, PlanWeekStatus>;
};

export type PlanNetworkStatus = {
  state: "queued" | "running" | "done" | "failed" | "stalled";
  step?: "loading" | "picking" | "writing" | "saving"; done?: number; total?: number;
  posts?: number; ai?: number; template?: number; gaps?: number; skipped?: string; error?: string; updatedAt?: string;
};
export type PlanWeekStatus = {
  runId: string; startedAt: string; source: "review" | "tick" | null; networks: Record<string, PlanNetworkStatus>;
  running: boolean; finished: number; total: number;
};

// The Calendar page (one brand, one month): published posts from the ledger plus approved, paused and sending posts.
export type CalendarPost = {
  id: string; postId: string | null; kind: "scheduled" | "published";
  status: "approved" | "paused" | "queued" | "publishing" | "processing" | "published";
  destination: string; accountName: string; placement: string; at: string;
  title: string | null; caption: string | null; hashtags: string[]; asset: ReviewAsset; externalUrl: string | null;
  carousel: boolean; custom: ReviewCustom | null; tiktok: TiktokSettings | null;
  passedOver: boolean; editable: boolean;
  // Latest stats snapshot (YouTube so far): taken 1h / 24h / 7d / 30d after publishing, only numbers that exist. null until one exists.
  stats: CalendarStats | null;
};
export type CalendarStatKey = "views" | "likes" | "comments" | "shares" | "watchTimeSeconds" | "avgViewDurationSeconds" | "followsGained" | "reach" | "saves" | "linkClicks";
export type CalendarStats = { asOf: "1h" | "24h" | "7d" | "30d"; source: string; metrics: Partial<Record<CalendarStatKey, number>> };
export type CalendarMonth = { ok: boolean; error?: string; brand: string; timeZone: string; month: string; start: string; end: string; today: string;
  // Approved posts still to come in any month (older API builds leave it out).
  upcomingApproved?: number; posts: CalendarPost[] };

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
