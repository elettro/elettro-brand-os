import { redirect, notFound } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { canAccessBrand } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { HOLIDAYS, HOLIDAY_BRANDS, type HolidayList, reviewCall } from "@/lib/planner-review";
import { HolidayClient } from "./holiday-client";

// Holidays (Dean, 2026-10-31): drafts per brand for a date every year. One brand shows only that brand's drafts;
// All brands shows every brand's drafts with an Approve all button and the approved list.
export default async function HolidayPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  if (!who.owner) notFound(); // owner only for now (the nav hides it from clients too)
  const { key } = await params;
  const holiday = HOLIDAYS.find((h) => h.key === key);
  if (!holiday) notFound();
  const { brand: requested } = await searchParams;
  const allowed = HOLIDAY_BRANDS.filter((id) => canAccessBrand(who, id));
  const single = allowed.includes(requested || "") ? requested! : "";
  const wanted = single ? [single] : allowed;
  const results = await Promise.all(wanted.map(async (brand) => {
    try {
      const { data } = await reviewCall<HolidayList>({ brand, action: "holiday-list", key });
      return data.ok ? data : null; // a brand with no database row (or no answer) is left out
    } catch { return null; }
  }));
  const lists = results.filter((l): l is HolidayList => !!l);
  const names = Object.fromEntries(brandConfigs.map((b) => [b.id, b.name]));
  return <main className="main">
    <div className="eyebrow"><a href="/holidays">Holidays</a> · {holiday.label}</div>
    <h1>{holiday.name}</h1>
    <p className="muted">Three ready-to-go {holiday.name} posts for each brand. Pick a brand in the header to see only that brand&apos;s, or leave it on All brands to approve them together. Approving puts a post into {holiday.label}&apos;s plan as an active post on each of the brand&apos;s connected networks. Edit the words, swap the picture or skip any you do not want.</p>
    {lists.length === 0 ? <p className="card" style={{ marginTop: 16 }}>No {holiday.name} drafts could be loaded.</p>
      : <HolidayClient holiday={holiday.key} holidayName={holiday.name} single={!!single} initial={lists} names={names} />}
  </main>;
}
