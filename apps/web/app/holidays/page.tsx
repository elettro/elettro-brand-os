import { redirect, notFound } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { HOLIDAYS } from "@/lib/planner-review";

// The holiday cards (Dean, 2026-10-31): pick one to see each brand's posts for it.
export default async function HolidaysPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  if (!who.owner) notFound();
  const { brand } = await searchParams;
  const q = brand ? `?brand=${encodeURIComponent(brand)}` : "";
  return <main className="main">
    <div className="eyebrow">Publishing · Holidays</div>
    <h1>Holidays</h1>
    <p className="muted">Pick a holiday to see each brand&apos;s ready-to-go posts for it. Approve them one by one, or all together on the All brands view.</p>
    <div className="hol-cards">
      {HOLIDAYS.map((h) => <a key={h.key} className="hol-tile" href={`/holidays/${h.key}${q}`}>
        <div className="eyebrow">{h.label}</div>
        <h2>{h.name}</h2>
        <span className="muted">Open the {h.name} posts →</span>
      </a>)}
    </div>
  </main>;
}
