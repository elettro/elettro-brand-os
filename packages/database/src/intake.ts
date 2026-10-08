import { deriveEligibilityWindow } from "./eligibility";

export type IntakeApprovalInput = {
  sendToApprovalQueue?: boolean;
};

export type IntakeBatchInput = {
  brandId: string;
  collectionId?: string | null;
  campaignId?: string | null;
  topic?: string | null;
  creativeFamily?: string | null;
  contentGroup?: string | null;
  creatorNote?: string | null;
  priority?: "low" | "normal" | "high";
  allowedDestinations?: string[];
  excludedDestinations?: string[];
  availability?: {
    mode: "evergreen" | "window";
    startDate?: string | null;
    stopDate?: string | null;
    repeatAnnually?: boolean;
  };
  approval?: IntakeApprovalInput;
};

export function normalizeIntakeBatch(input: IntakeBatchInput) {
  const eligibility = deriveEligibilityWindow(
    input.availability ?? { mode: "evergreen" }
  );

  return {
    brandId: input.brandId,
    collectionId: input.collectionId ?? null,
    campaignId: input.campaignId ?? null,
    topic: input.topic?.trim() || null,
    creativeFamily: input.creativeFamily?.trim() || null,
    contentGroup: input.contentGroup?.trim() || null,
    creatorNote: input.creatorNote?.trim() || null,
    priority: input.priority ?? "normal",
    allowedDestinations: input.allowedDestinations ?? [],
    excludedDestinations: input.excludedDestinations ?? [],
    approvalStatus: input.approval?.sendToApprovalQueue ? "needs_review" : "approved",
    ...eligibility
  } as const;
}

export function validateIntakeBatch(input: IntakeBatchInput) {
  const errors: string[] = [];

  if (!input.brandId?.trim()) errors.push("brandId is required");

  if (input.availability?.mode === "window") {
    if (!input.availability.startDate) errors.push("startDate is required for a publishing window");
    if (!input.availability.stopDate) errors.push("stopDate is required for a publishing window");
  }

  return errors;
}
