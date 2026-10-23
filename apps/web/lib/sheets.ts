// Public one-sheets shown on /welcome. "soon" marks sheets that show features not built yet.
export type Sheet = { slug: string; group: "restaurants" | "venues" | "hotels" | "video" | "growth"; title: string; soon: boolean; w: number; h: number };

export const SHEET_GROUPS: Array<{ id: Sheet["group"] | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "restaurants", label: "Restaurants" },
  { id: "venues", label: "Event venues" },
  { id: "hotels", label: "Hotels and resorts" },
  { id: "video", label: "AI video" },
  { id: "growth", label: "Growth system" }
];

export const SHEETS: Sheet[] = [
  { slug: "restaurant-brunch", group: "restaurants", title: "Turn brunch content into bigger tables", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-happy-hour", group: "restaurants", title: "Turn happy hour content into busier nights", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-scenic-dining", group: "restaurants", title: "Turn scenic dining into more tables", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-cafe", group: "restaurants", title: "Turn coffee and pastries into foot traffic", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-pizza", group: "restaurants", title: "Turn pizza nights into fuller tables", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-local-buzz", group: "restaurants", title: "Turn local buzz into packed tables", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-rooftop", group: "restaurants", title: "Rooftop dining, sunset cocktails, packed tables", soon: false, w: 960, h: 1706 },
  { slug: "restaurant-reservations", group: "restaurants", title: "More reservations, fuller tables, happier guests", soon: false, w: 960, h: 1706 },
  { slug: "venues-event-calendar", group: "venues", title: "Fill your event calendar year-round", soon: false, w: 960, h: 1706 },
  { slug: "hotels-direct-bookings", group: "hotels", title: "Turn more views into direct bookings", soon: false, w: 960, h: 1706 },
  { slug: "venues-full-calendars", group: "venues", title: "Turn events into full calendars", soon: false, w: 960, h: 1706 },
  { slug: "venues-event-space", group: "venues", title: "Fill your event space year-round", soon: false, w: 960, h: 1706 },
  { slug: "video-consistency", group: "video", title: "Consistency across every campaign", soon: false, w: 960, h: 1706 },
  { slug: "video-more-content", group: "video", title: "More content, less friction", soon: false, w: 960, h: 1706 },
  { slug: "video-concept-to-content", group: "video", title: "From concept to content, fast", soon: false, w: 960, h: 1706 },
  { slug: "video-infrastructure", group: "video", title: "Dedicated AI video infrastructure", soon: false, w: 960, h: 1706 },
  { slug: "video-learns-the-brand", group: "video", title: "A video system that learns the brand", soon: false, w: 960, h: 1706 },
  { slug: "video-what-it-can-do", group: "video", title: "What Elettro can do with dedicated AI video", soon: false, w: 960, h: 1357 },
  { slug: "video-social-campaigns", group: "video", title: "Social video campaigns at scale", soon: false, w: 960, h: 1706 },
  { slug: "video-product-promos", group: "video", title: "Product promos and ad variations", soon: false, w: 960, h: 1706 },
  { slug: "growth-5-steps-a", group: "growth", title: "5 steps to higher conversion", soon: true, w: 960, h: 1706 },
  { slug: "growth-measure-engagement", group: "growth", title: "Measure engagement", soon: true, w: 960, h: 1706 },
  { slug: "growth-score-winners-a", group: "growth", title: "Score the winners", soon: true, w: 960, h: 1706 },
  { slug: "growth-business-channel", group: "growth", title: "Business channel intelligence for LinkedIn and Google Business Profile", soon: true, w: 960, h: 1706 },
  { slug: "growth-step-4", group: "growth", title: "Step 4: score the winners", soon: true, w: 960, h: 1706 },
  { slug: "growth-step-5", group: "growth", title: "Step 5: boost and scale", soon: true, w: 960, h: 1706 },
  { slug: "growth-step-3", group: "growth", title: "Step 3: measure engagement", soon: true, w: 960, h: 1706 },
  { slug: "growth-step-2", group: "growth", title: "Step 2: publish and test", soon: false, w: 960, h: 1706 },
  { slug: "growth-5-steps-b", group: "growth", title: "5 steps to higher conversion", soon: true, w: 960, h: 1706 },
  { slug: "growth-step-1", group: "growth", title: "Step 1: register and tag assets", soon: false, w: 960, h: 1706 },
  { slug: "blueprint-neon-coastal", group: "growth", title: "Marketing intelligence blueprint", soon: true, w: 960, h: 1241 },
  { slug: "blueprint-elettro-os", group: "growth", title: "Moneyball your marketing assets", soon: true, w: 960, h: 1241 },
  { slug: "blueprint-poster", group: "growth", title: "Moneyball your marketing assets: poster", soon: true, w: 960, h: 1241 }
];
