import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";

// Any signed-in user (owner or client). Signed-out visitors go to sign-in.
export async function requireSession() {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  return who;
}

// Owner only. A signed-in client is sent home instead of round-tripping through sign-in.
export async function requireOwner() {
  const who = await requireSession();
  if (!who.owner) redirect("/");
  return who;
}

// The brand list a data call must be limited to: null for the owner (everything), the user's brands for a client.
export function scopeOf(who: { owner: boolean; brands: string[] }): string[] | null {
  return who.owner ? null : who.brands;
}
