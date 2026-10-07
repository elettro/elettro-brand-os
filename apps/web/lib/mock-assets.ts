export type MockAsset = {
  id: string;
  brandId: string;
  filename: string;
  kind: "video" | "image";
  contentGroup: string;
  eligibility: string;
  approval: "needs_review" | "approved";
  status: "ready" | "needs_review";
};

export const mockAssets: MockAsset[] = [
  {
    id: "a1",
    brandId: "solarmeister",
    filename: "christmas-storage-vertical-01.mp4",
    kind: "video",
    contentGroup: "holiday",
    eligibility: "Annual · Sep 15–Dec 25",
    approval: "approved",
    status: "ready"
  },
  {
    id: "a2",
    brandId: "stashbox",
    filename: "live-band-reel-01.mp4",
    kind: "video",
    contentGroup: "live performance",
    eligibility: "Evergreen",
    approval: "needs_review",
    status: "needs_review"
  },
  {
    id: "a3",
    brandId: "neckermann-strom",
    filename: "energy-advice-01.png",
    kind: "image",
    contentGroup: "educational",
    eligibility: "Evergreen",
    approval: "approved",
    status: "ready"
  }
];
