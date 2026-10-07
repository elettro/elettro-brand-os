import { isAssetEligible, type EligibilityInput } from "./eligibility";

export type PoolAsset = EligibilityInput & {
  id: string;
  approvalStatus: "needs_review" | "approved" | "rejected";
  ingestStatus: "ingesting" | "needs_review" | "ready" | "failed" | "source_missing";
};

export function isInContentPool(asset: PoolAsset, at: Date) {
  return (
    asset.approvalStatus === "approved" &&
    asset.ingestStatus === "ready" &&
    isAssetEligible(asset, at)
  );
}
