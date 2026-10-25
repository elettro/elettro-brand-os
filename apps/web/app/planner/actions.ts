"use server";

import { redirect } from "next/navigation";
import { authenticatedFor } from "@/lib/cognito-auth";
import { plannerCall } from "@/lib/planner";

type Result = { ok: boolean; error?: string; approved?: number; updated?: number };

function back(formData: FormData, message: string): never {
  const params = new URLSearchParams({
    brand: String(formData.get("brand") || "stashbox"),
    week: String(formData.get("week") || ""),
    msg: message
  });
  redirect(`/planner?${params}`);
}

// Owner, or a user with access to the brand in the submitted form.
async function owner(formData: FormData) {
  if (!(await authenticatedFor(String(formData.get("brand") || "")))) redirect("/api/auth/login");
}

export async function approveWeek(formData: FormData) {
  await owner(formData);
  const r = await plannerCall<Result>({ action: "approve-week", brandSlug: formData.get("brand"), weekStart: formData.get("week") });
  back(formData, r.ok ? `Approved ${r.approved} posts.` : `Could not approve: ${r.error}`);
}

export async function requestReplan(formData: FormData) {
  await owner(formData);
  const r = await plannerCall<Result>({ action: "request-replan", brandSlug: formData.get("brand"), weekStart: formData.get("week") });
  back(formData, r.ok ? "Re-plan queued. The planner rebuilds this week's unapproved posts within 15 minutes." : `Could not queue: ${r.error}`);
}

export async function saveCadence(formData: FormData) {
  await owner(formData);
  const rules = [...formData.entries()]
    .filter(([name]) => name.startsWith("ppw:"))
    .map(([name, value]) => ({ id: name.slice(4), postsPerWeek: Number(value) }));
  const r = await plannerCall<Result>({ action: "set-cadence", brandSlug: formData.get("brand"), rules });
  back(formData, r.ok
    ? `Saved ${r.updated} change${r.updated === 1 ? "" : "s"}. Weeks not planned yet use the new numbers; re-plan a week to apply them there.`
    : `Could not save: ${r.error}`);
}
