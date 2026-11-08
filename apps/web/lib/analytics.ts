// Analytics page types (2026-11-08). The numbers come from the dev-api review action "analytics" (services/dev-api-lambda/analytics.mjs).

export type AnalyticsPost = {
  id: string; destination: string; placement: string; account: string | null; title: string | null; publishedAt: string; url: string | null;
  pillar: string | null; measured: boolean; story: boolean; bucket: "1h" | "24h" | "7d" | "30d" | null; takenAfterHours: number | null; onTime: boolean | null;
  main: number | null;
  metrics: { views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; clicks: number | null; watchTimeSeconds: number | null; avgViewSeconds: number | null };
  why: { score: number | null; exploration: boolean; breakdown: Record<string, number> } | null;
};

export type AnalyticsNetwork = {
  destination: string; mainLabel: string; posts: number; stories: number; measured: number; total: number; typical: number | null;
  likes: number | null; comments: number | null; shares: number | null; clicks: number | null;
  ready: { account: string | null; onTime7d: number; of: number };
  top: AnalyticsPost[];
  pillars?: Array<{ slug: string | null; label: string; posts: number; typical: number | null; trust: boolean }>;
  times?: Array<{ label: string; posts: number; typical: number | null }>;
};

export type BrandAnalytics = {
  ok: boolean; error?: string; brand: string; days: number; sort: "main" | "clicks"; generatedAt: string;
  totals: { posts: number; measured: number; waiting: number; clicks: number; readyAccounts: number; accounts: number; closest: { destination: string; accountName: string; onTime7d: number } | null };
  networks: AnalyticsNetwork[];
};

// The brands the page covers: the active brands with publishing (Google Review is the API reviewer's demo brand; Dean Palermo, Rompe and Reggae.Land are inactive).
export const ANALYTICS_BRANDS = ["stashbox", "solarmeister", "elettro", "pianomusicsoothing", "neckermann-strom", "therasbox", "weightlossdavie"];

export const NETWORK_NAMES: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", threads: "Threads", pinterest: "Pinterest",
  linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon", tiktok: "TikTok", x: "X", gmb: "Google Business",
  snapchat: "Snapchat", substack: "Substack"
};

// Plain names for the planner's score parts (planner-v2.mjs).
export const WHY_LABELS: Record<string, string> = {
  balance: "Pillar balance", freshness: "Freshness", newBatch: "New batch", priority: "Priority", songVariety: "Song variety",
  groupVariety: "Group variety", ready: "Ready tag", durationFit: "Length fits", exploration: "Exploration", tiebreak: "Tie-break"
};

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Math.round(n).toLocaleString("en-US"));

export function watchTime(seconds: number | null) {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "1 day · on time" or "caught up · 9 days": when the numbers were taken, and whether that was on schedule. */
export function measuredLabel(p: AnalyticsPost) {
  if (!p.measured || p.takenAfterHours === null) return "not measured yet";
  const h = p.takenAfterHours;
  const age = h < 1 ? "under an hour" : h < 48 ? `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}` : `${Math.round(h / 24)} days`;
  return p.onTime ? `${age} · on time` : `caught up · ${age}`;
}
