export type EligibilityType = "evergreen" | "annual" | "one_time";

export type EligibilityInput = {
  eligibilityType: EligibilityType;
  eligibleFrom?: Date | null;
  eligibleUntil?: Date | null;
  annualFromMmdd?: number | null;
  annualUntilMmdd?: number | null;
  containsSpecificPricing?: boolean;
  retiredAt?: Date | null;
};

function mmdd(date: Date) {
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function isAssetEligible(asset: EligibilityInput, at: Date) {
  if (asset.retiredAt) return false;
  if (asset.containsSpecificPricing && asset.eligibilityType !== "one_time") return false;

  if (asset.eligibilityType === "evergreen") return true;

  if (asset.eligibilityType === "one_time") {
    if (!asset.eligibleFrom || !asset.eligibleUntil) return false;
    return at >= asset.eligibleFrom && at <= asset.eligibleUntil;
  }

  if (!asset.annualFromMmdd || !asset.annualUntilMmdd) return false;
  const value = mmdd(at);
  const start = asset.annualFromMmdd;
  const end = asset.annualUntilMmdd;

  if (start <= end) return value >= start && value <= end;
  return value >= start || value <= end;
}
