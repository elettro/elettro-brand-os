export const publishingDestinations = [
  { id: "instagram", label: "Instagram", kind: "social" },
  { id: "facebook", label: "Facebook", kind: "social" },
  { id: "tiktok", label: "TikTok", kind: "social" },
  { id: "youtube", label: "YouTube", kind: "social" },
  { id: "threads", label: "Threads", kind: "social" },
  { id: "x", label: "X", kind: "social" },
  { id: "website", label: "Website", kind: "owned" },
  { id: "wordpress", label: "WordPress", kind: "owned" },
  { id: "shopify", label: "Shopify", kind: "owned" },
  { id: "rss", label: "RSS Feed", kind: "feed" }
] as const;
export type PublishingDestinationId = typeof publishingDestinations[number]["id"];
export type DestinationTarget = { id: string; kind: "social" | "owned" | "feed"; brandId: string; label: string; url?: string; enabled: boolean };
/** The destination category is not proof of a configured publishing connection. */
export const supportedDestinationCategories = ["social", "owned", "feed"] as const;
