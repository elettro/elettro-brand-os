import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { canAccessBrand, visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { REVIEW_BRANDS, type CalendarMonth, reviewCall } from "@/lib/planner-review";
import { CalendarClient } from "./calendar-client";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// One brand at a time (Dean, 2026-10-31: an all-brands calendar would be overload).
export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const { brand: requested, month: requestedMonth } = await searchParams;
  const allowed = REVIEW_BRANDS.filter((id) => canAccessBrand(who, id));
  // "All brands" (or no choice) in the header switcher opens the first brand this user can see.
  const brand = allowed.includes(requested || "") ? requested! : allowed[0] ?? "";
  const month = MONTH.test(requestedMonth || "") ? requestedMonth : undefined;
  let data: CalendarMonth | null = null;
  let error: string | null = null;
  if (!brand) {
    error = "None of your brands have a publishing calendar yet";
  } else {
    try {
      const r = await reviewCall<CalendarMonth>({ brand, action: "calendar", month });
      if (r.data.ok) data = r.data; else error = r.data.error || "The planner did not answer";
    } catch {
      error = "Elettro OS could not reach the planner";
    }
  }
  const brandName = brandConfigs.find((b) => b.id === brand)?.name;
  const brands = visibleBrands(who, brandConfigs.filter((b) => REVIEW_BRANDS.includes(b.id))).map((b) => ({ id: b.id, name: b.name }));
  return <main className="main">
    <div className="eyebrow">Publishing · Calendar</div>
    <h1>Calendar</h1>
    <p className="muted">What went out and what is approved to go out. Approve posts on Review; they show up here. Click a post to see it, pause it, edit it, swap it for a brand-new post, or remove it.</p>
    <nav className="review-brands" aria-label="Brand">
      {brands.map((b) => <a key={b.id} href={`/calendar?brand=${b.id}`} className={b.id === brand ? "active" : undefined}>{b.name}</a>)}
    </nav>
    {error && <p className="card" style={{ marginTop: 16 }}>Could not load the calendar: {error}</p>}
    {data && <CalendarClient key={brand} initial={data} brandName={brandName} />}
  </main>;
}
