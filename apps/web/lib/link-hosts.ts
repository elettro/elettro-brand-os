// Tracked-link constants, safe for middleware (no server-only imports). Runbook: docs/admin/link-tracking.md.

// Short-link host → the brand's home page (where a bad or unknown link lands). Add SolarMeister here when it goes on.
// Kept in step with Brand.settings.linkTracking.host (set by the dev-api action setup-link-tracking-20261107).
export const LINK_HOSTS: Record<string, { brand: string; home: string; bio?: boolean }> = {
  // go.stashbox.com is the public face (Instagram bio link, new caption links, Dean 2026-11-08); go.stashbox.ai keeps working for
  // every link already posted and for the Shopify pixel's endpoint.
  "go.stashbox.com": { brand: "stashbox", home: "https://stashbox.com", bio: true },
  "go.stashbox.ai": { brand: "stashbox", home: "https://stashbox.ai", bio: true }
};
export const FALLBACK_HOME = "https://elettro.com";

// Same alphabet and length as CODE_PATTERN in services/dev-api-lambda/link-tracking.mjs.
export const LINK_CODE = /^[2-9a-km-zA-HJ-NP-Z]{7}$/;
export const PIXEL_KINDS = ["page_view", "product_view", "add_to_cart", "checkout_started", "purchase"] as const;

export function homeForHost(host: string | null | undefined): string {
  return LINK_HOSTS[String(host || "").toLowerCase().split(":")[0]]?.home || FALLBACK_HOME;
}
