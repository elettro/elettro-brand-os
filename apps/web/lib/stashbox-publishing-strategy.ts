export const stashboxStrategy = {
  Instagram: { reelsPerDay: 2, feedPerWeek: [3,4], storiesPerDay: [3,5] },
  Facebook: { reelsPerDay: 2, feedPerWeek: [8,10], storiesPerDay: [4,5] },
  TikTok: { videosPerDay: 4, videosPerWeek: [10,14], experimentPercent: 40, duration: "adaptive" },
  YouTube: { shortsPerDay: 3, shortsPerWeek: [10,14], longVideosPerWeek: [2,3], releases: "standard", notifications: "selective" },
  Threads: { originalsPerDay: 5, originalsPerWeek: [14,21], promotionsMaxPercent: 25, replies: "suggest", tone: "conversational" },
  X: { originalsPerDay: 8, originalsPerWeek: [14,21], promotionsMaxPercent: 25, replies: "suggest", formats: "balanced" },
  LinkedIn: { originalsPerWeek: [2,3], purpose: "business development" },
  campaignShare: 0.6,
  reuseCooldownDays: 30,
  simulationOnly: true
} as const;
