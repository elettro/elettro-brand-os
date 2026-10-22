/**
 * Every publishing format the Review page's Posts Per Day controls know about, one row per
 * network + placement. The Review page reads this list (via the review "list" action), so a new
 * format or a format whose publisher goes live is a one-line change here.
 *
 * status
 *   live         planned, and approved posts publish on schedule (a claim-due-posts worker)
 *   planning     planned and scheduled; the publisher for this format isn't built yet
 *   review       planned and scheduled; waiting on the network's app review
 *   integration  not connected to Elettro OS yet: shown, never editable or planned
 *
 * rule: the planner's pool rule for the placement when the brand's planner settings don't set one
 * (photo formats take images, not the brand's default vertical video pool).
 */
export const PUBLISHING_FORMATS = [
  { destination: "instagram", placement: "reel", label: "Reels", status: "live" },
  { destination: "instagram", placement: "story", label: "Stories", status: "planning", note: "Story publishing isn't built yet" },
  { destination: "instagram", placement: "post", label: "Feed photos", status: "planning", note: "Publisher is deployed; no feed photo has published on schedule yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "facebook", placement: "reel", label: "Reels", status: "live" },
  { destination: "facebook", placement: "story", label: "Stories", status: "planning", note: "Story publishing isn't built yet" },
  { destination: "facebook", placement: "post", label: "Photo / wide video posts", status: "planning", note: "Publisher is deployed; no photo or wide video has published on schedule yet",
    rule: { kinds: ["image", "video"], aspectRatios: [] } },
  { destination: "tiktok", placement: "video", label: "Videos", status: "review", note: "Scheduled publishing is built; waiting on TikTok's app review" },
  { destination: "threads", placement: "post", label: "Posts", status: "live" },
  { destination: "youtube", placement: "short", label: "Shorts", status: "live" },
  { destination: "youtube", placement: "video", label: "Long-form videos", status: "live",
    rule: { aspectRatios: ["16x9"], minDurationBucket: "3min-plus" } },
  { destination: "pinterest", placement: "pin", label: "Image pins", status: "planning", note: "Pin test posts work; scheduled auto-publishing isn't built yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "pinterest", placement: "video", label: "Video pins", status: "planning", note: "Video Pin test posts work; scheduled auto-publishing isn't built yet",
    rule: { kinds: ["video"], aspectRatios: [] } },
  { destination: "linkedin", placement: "post", label: "Posts", status: "planning", note: "LinkedIn test posts work; scheduled auto-publishing isn't built yet",
    rule: { kinds: ["image", "video"], aspectRatios: [] } },
  { destination: "x", placement: "video", label: "Videos", status: "integration", note: "X isn't connected to Elettro OS yet" },
  { destination: "gmb", placement: "update", label: "Update posts", status: "integration", note: "Waiting on Google's API allowlist" }
];

// A network takes at most 10 posts a day across all its formats.
export const MAX_POSTS_PER_DAY = 10;
export const MAX_POSTS_PER_WEEK = MAX_POSTS_PER_DAY * 7;

export const isPlannable = (f) => f && f.status !== "integration";
export const formatOf = (destination, placement) =>
  PUBLISHING_FORMATS.find((f) => f.destination === destination && f.placement === placement) || null;
export const FORMAT_DESTINATIONS = [...new Set(PUBLISHING_FORMATS.map((f) => f.destination))];
export const PLANNABLE_DESTINATIONS = [...new Set(PUBLISHING_FORMATS.filter(isPlannable).map((f) => f.destination))];

/** The planner's pool rule for a placement: the brand's own setting wins, then the catalog default. */
export function placementRule(settings, destination, placement) {
  const key = `${destination}:${placement}`;
  return settings?.placements?.[key] || formatOf(destination, placement)?.rule || {};
}
