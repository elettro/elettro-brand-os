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
 * slides (carousel formats): the network's hard limits (min..max, enforced), the recommended range (shown
 *   next to the boxes, advisory) and the default a brand gets until it sets its own.
 *
 * rule: the planner's pool rule for the placement when the brand's planner settings don't set one
 * (photo formats take images, not the brand's default vertical video pool).
 */
export const PUBLISHING_FORMATS = [
  { destination: "instagram", placement: "reel", label: "Reels", status: "live" },
  { destination: "instagram", placement: "story", label: "Stories", status: "live" },
  { destination: "instagram", placement: "post", label: "Feed photos", status: "live",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "instagram", placement: "carousel", label: "Carousels", status: "planning", note: "Scheduled publishing is built; goes live after the first scheduled carousel posts",
    slides: { min: 2, max: 10, recommended: [5, 8] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "facebook", placement: "reel", label: "Reels", status: "live" },
  { destination: "facebook", placement: "story", label: "Stories", status: "live" },
  { destination: "facebook", placement: "post", label: "Photo / wide video posts", status: "live",
    rule: { kinds: ["image", "video"], aspectRatios: [] } },
  { destination: "facebook", placement: "carousel", label: "Multi-photo posts", status: "planning", note: "Scheduled publishing is built; goes live after the first scheduled multi-photo post",
    slides: { min: 2, max: 10, recommended: [3, 6] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "tiktok", placement: "video", label: "Videos", status: "review", note: "Scheduled publishing is built; waiting on TikTok's app review" },
  { destination: "tiktok", placement: "carousel", label: "Photo carousels", status: "review", note: "Scheduled publishing is built; needs the verified image host and TikTok's app review",
    slides: { min: 2, max: 35, recommended: [6, 10] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "threads", placement: "post", label: "Posts", status: "live" },
  { destination: "threads", placement: "carousel", label: "Carousels", status: "planning", note: "Scheduled publishing is built; goes live after the first scheduled carousel posts",
    slides: { min: 2, max: 20, recommended: [3, 6] }, rule: { kinds: ["image"], aspectRatios: [] } },
  // Bluesky: a post takes one photo, one video or up to 4 photos (no mixing). Connect and the publisher (services/bluesky-lambda) are built.
  { destination: "bluesky", placement: "post", label: "Photo posts", status: "planning", note: "Publisher is built (services/bluesky-lambda); no post has published on schedule yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "bluesky", placement: "carousel", label: "Multi-photo posts", status: "planning", note: "Publisher is built (services/bluesky-lambda); no post has published on schedule yet",
    slides: { min: 2, max: 4, recommended: [2, 4] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "bluesky", placement: "video", label: "Videos", status: "planning", note: "Publisher is built (services/bluesky-lambda); no video has published on schedule yet. Videos up to 3 minutes and 100 MB",
    rule: { kinds: ["video"], aspectRatios: [], maxDurationBucket: "1-3min", maxBytes: 100 * 1024 * 1024 } },
  { destination: "youtube", placement: "short", label: "Shorts", status: "live" },
  { destination: "youtube", placement: "video", label: "Long-form videos", status: "live",
    rule: { aspectRatios: ["16x9"], minDurationBucket: "3min-plus" } },
  { destination: "pinterest", placement: "pin", label: "Image pins", status: "planning", note: "Publisher is deployed; no pin has published on schedule yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "pinterest", placement: "carousel", label: "Carousel Pins", status: "planning", note: "Scheduled publishing is built; goes live after the first scheduled carousel Pin",
    slides: { min: 2, max: 5, recommended: [3, 5] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "pinterest", placement: "video", label: "Video pins", status: "planning", note: "Publisher is deployed; no video pin has published on schedule yet",
    rule: { kinds: ["video"], aspectRatios: [] } },
  // Mastodon (mastodon.social, text up to 500 characters): a post takes up to 4 photos or one video. Publisher: services/mastodon-lambda.
  { destination: "mastodon", placement: "post", label: "Photo posts", status: "planning", note: "Publisher is built (services/mastodon-lambda); no post has published on schedule yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "mastodon", placement: "carousel", label: "Multi-photo posts", status: "planning", note: "Publisher is built (services/mastodon-lambda); no post has published on schedule yet",
    slides: { min: 2, max: 4, recommended: [2, 4] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "mastodon", placement: "video", label: "Videos", status: "planning", note: "Publisher is built (services/mastodon-lambda); no video has published on schedule yet. Videos up to 99 MB",
    rule: { kinds: ["video"], aspectRatios: [], maxDurationBucket: "1-3min" } },
  // Snapchat (Public Profile API, allowlisted): vertical MP4 video, 5-60 s. A Story lasts 24 hours and carries no text; a Spotlight takes a
  // 160-character description and goes through Snap's review. Connect and the publisher (services/snapchat-lambda) are built.
  { destination: "snapchat", placement: "story", label: "Stories", status: "planning", note: "Publisher is built (services/snapchat-lambda); waiting on Snap's Public Profile API allowlist. Vertical video, 5-60 seconds",
    rule: { kinds: ["video"], aspectRatios: ["9x16"], maxDurationBucket: "30-60s" } },
  { destination: "snapchat", placement: "spotlight", label: "Spotlight", status: "planning", note: "Publisher is built (services/snapchat-lambda); waiting on Snap's Public Profile API allowlist. Vertical video, 5-60 seconds; Snap reviews each Spotlight",
    rule: { kinds: ["video"], aspectRatios: ["9x16"], maxDurationBucket: "30-60s" } },
  // Substack: no official publishing API; the publisher (services/substack-lambda) uses the internal API with a pasted session cookie.
  // One picture + a title and short body, published live on the web (never emailed to subscribers by a scheduled post).
  { destination: "substack", placement: "post", label: "Photo posts", status: "planning", note: "Publisher is built (services/substack-lambda, unofficial API); no post has published on schedule yet",
    rule: { kinds: ["image"], aspectRatios: [] } },
  // Substack gallery: 2-20 pictures from one sector in a single post (intro text, then the pictures in order). A gallery is a big post, so
  // Review shows it per WEEK by default (defaultUnit) and allows at most 7 a week. Placement is "carousel" so the planner builds it from one sector's images.
  { destination: "substack", placement: "carousel", label: "Galleries", status: "planning", defaultUnit: "week", maxPostsPerWeek: 7, slidesNoun: "gallery",
    note: "Publisher is built (services/substack-lambda, unofficial API); no gallery has published on schedule yet. 2-20 pictures per gallery",
    slides: { min: 2, max: 20, recommended: [4, 8] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "linkedin", placement: "post", label: "Posts", status: "planning", note: "Publisher is built (services/linkedin-lambda); no post has published on schedule yet",
    rule: { kinds: ["image", "video"], aspectRatios: [] } },
  { destination: "linkedin", placement: "carousel", label: "Multi-image posts", status: "planning", note: "Scheduled publishing is built; goes live after the first scheduled multi-image post",
    slides: { min: 2, max: 20, recommended: [3, 9] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "linkedin", placement: "document", label: "PDF documents", status: "planning", note: "Built from a carousel's images into a swipeable PDF; goes live after the first scheduled document post",
    slides: { min: 3, max: 20, recommended: [5, 10] }, rule: { kinds: ["image"], aspectRatios: [] } },
  // Written by hand on Review (linkedin-custom.mjs), never planned: they carry no media of their own.
  { destination: "linkedin", placement: "text", label: "Text posts", status: "integration", note: "Written by hand on Review; not planned automatically" },
  { destination: "linkedin", placement: "link", label: "Link posts", status: "integration", note: "Written by hand on Review; not planned automatically" },
  { destination: "linkedin", placement: "poll", label: "Polls", status: "integration", note: "Written by hand on Review; not planned automatically" },
  // X (api.x.com, pay-per-use credits): 280 characters (a link counts as 23), up to 4 photos. Publisher: services/x-lambda. Video uses X's chunked upload (services/x-lambda).
  { destination: "x", placement: "post", label: "Photo posts", status: "planning", note: "Publisher is built (services/x-lambda); no post has published on schedule yet. Each post costs X credits ($0.015, $0.20 with a link)",
    rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "x", placement: "carousel", label: "Multi-photo posts", status: "planning", note: "Publisher is built (services/x-lambda); no post has published on schedule yet",
    slides: { min: 2, max: 4, recommended: [2, 4] }, rule: { kinds: ["image"], aspectRatios: [] } },
  { destination: "x", placement: "video", label: "Videos", status: "planning", note: "Publisher is built (services/x-lambda, chunked upload); no video has published on schedule yet. Up to 1 GB, 3 minutes",
    rule: { kinds: ["video"], aspectRatios: [], maxDurationBucket: "1-3min" } },
  // savesCadence: the Review box stores a target (3 a day at most, Dean 2026-11-04) but the planner still skips GMB:
  // planning is by destination (PLANNABLE_DESTINATIONS), which excludes it until the GMB planner exists.
  { destination: "gmb", placement: "update", label: "Update posts", status: "integration", savesCadence: true, maxPostsPerWeek: 21, note: "Posts per day is saved (3 a day at most). Profiles connected; publisher built (services/gmb-lambda) for Update posts (Offers parked, Events wait for a real show). Review → Plan plans them (gmb-planner.mjs); Stashbox goes out without approval" }
];

// A network takes at most 12 posts a day across all its formats.
export const MAX_POSTS_PER_DAY = 14;
export const MAX_POSTS_PER_WEEK = MAX_POSTS_PER_DAY * 7;

export const isPlannable = (f) => f && f.status !== "integration";
/** Whether Review may store a posts-per-week number for the format (planned formats, and GMB's saved target). */
export const canSaveCadence = (f) => Boolean(f) && (isPlannable(f) || f.savesCadence === true);
export const formatOf = (destination, placement) =>
  PUBLISHING_FORMATS.find((f) => f.destination === destination && f.placement === placement) || null;
export const FORMAT_DESTINATIONS = [...new Set(PUBLISHING_FORMATS.map((f) => f.destination))];
export const PLANNABLE_DESTINATIONS = [...new Set(PUBLISHING_FORMATS.filter(isPlannable).map((f) => f.destination))];

/** The planner's pool rule for a placement: the brand's own setting wins, then the catalog default. */
export function placementRule(settings, destination, placement) {
  const key = `${destination}:${placement}`;
  return settings?.placements?.[key] || formatOf(destination, placement)?.rule || {};
}

/** Carousel limits for a format, or null when it isn't a carousel format. */
export const slidesOf = (destination, placement) => formatOf(destination, placement)?.slides || null;

/**
 * The slide range for one carousel format: the brand's own min/max (Brand.settings.carouselSlides["<dest>:carousel"], set from Review)
 * clamped to the network's hard limits, else the recommended range. Null for non-carousel formats.
 */
export function slideRange(settings, destination, placement) {
  const limits = slidesOf(destination, placement);
  if (!limits) return null;
  const own = settings?.carouselSlides?.[`${destination}:${placement}`] || settings?.placements?.[`${destination}:${placement}`]?.slides || {};
  const clamp = (n) => Math.min(limits.max, Math.max(limits.min, Math.round(Number(n))));
  const min = Number.isFinite(Number(own.min)) ? clamp(own.min) : limits.recommended[0];
  const max = Number.isFinite(Number(own.max)) ? Math.max(min, clamp(own.max)) : Math.max(min, limits.recommended[1]);
  return { min, max };
}
