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

export type EligibilityWindowInput = {
  mode: "evergreen" | "window";
  startDate?: string | null;
  stopDate?: string | null;
  repeatAnnually?: boolean;
};

export type EligibilityWindowResult = {
  eligibilityType: EligibilityType;
  eligibleFrom: Date | null;
  eligibleUntil: Date | null;
  annualFromMmdd: number | null;
  annualUntilMmdd: number | null;
};

function mmdd(date: Date) {
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function parseDateOnly(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function deriveEligibilityWindow(input: EligibilityWindowInput): EligibilityWindowResult {
  if (input.mode === "evergreen") {
    return {
      eligibilityType: "evergreen",
      eligibleFrom: null,
      eligibleUntil: null,
      annualFromMmdd: null,
      annualUntilMmdd: null
    };
  }

  const start = parseDateOnly(input.startDate);
  const stop = parseDateOnly(input.stopDate);

  if (!start || !stop) {
    throw new Error("A publishing window requires both a start date and a stop date.");
  }

  if (input.repeatAnnually) {
    return {
      eligibilityType: "annual",
      eligibleFrom: null,
      eligibleUntil: null,
      annualFromMmdd: mmdd(start),
      annualUntilMmdd: mmdd(stop)
    };
  }

  if (stop < start) {
    throw new Error("A one-time publishing window cannot stop before it starts.");
  }

  return {
    eligibilityType: "one_time",
    eligibleFrom: start,
    eligibleUntil: stop,
    annualFromMmdd: null,
    annualUntilMmdd: null
  };
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

  // Annual windows may wrap New Year, e.g. Nov 15 → Jan 5.
  return value >= start || value <= end;
}
