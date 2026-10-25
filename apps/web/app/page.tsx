import { session } from "@/lib/cognito-auth";
import { canAccessBrand } from "@/lib/brand-access";
import { redirect } from "next/navigation";
import { StatsBrandSelect } from "@/components/stats-brand-select";
import { plannerCall, type DashboardStats, type StatCounts } from "@/lib/planner";

const STATUS_LABEL: Record<string, string> = {
  live: "Live", planning: "Planning", review: "In app review", integration: "Not connected"
};

// Per-format cells shown in every row, in reading order.
const PERIODS: Array<[keyof StatCounts, string]> = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["total", "All time"]];

const sum = (stats: DashboardStats, key: keyof StatCounts) => stats.networks.reduce((n, net) => n + net.totals[key], 0);

function Cell({ value, label, tone }: { value: number; label: string; tone?: "warn" | "danger" }) {
  return (
    <div className={`stat-cell${value === 0 ? " zero" : ""}${tone ? ` ${tone}` : ""}`}>
      <b>{value.toLocaleString("en-US")}</b>
      <span>{label}</span>
    </div>
  );
}

const MACRO: Array<[keyof StatCounts, string, "warn" | "danger" | undefined]> = [
  ["total", "Posts all time", undefined], ["month", "This month", undefined], ["week", "This week", undefined], ["today", "Today", undefined],
  ["scheduled", "Approved & scheduled", undefined], ["awaiting", "Awaiting approval", "warn"], ["failed", "Failed this month", "danger"],
  ["possible", "Possible assets", undefined]
];

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/welcome");
  const requested = (await searchParams).brand;
  // The all-brands view adds up every brand, so a restricted user is always pinned to one of theirs.
  if (!who.owner && !canAccessBrand(who, requested || "")) redirect("/?brand=" + encodeURIComponent(who.brands[0]));
  const scope = requested || "all";
  const stats = await plannerCall<DashboardStats>({ action: "stats", brandSlug: scope });

  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Publishing · Dashboard</div>
          <h1>{stats.ok ? (scope === "all" ? "All brands" : stats.brands.find((b) => b.slug === scope)?.name ?? scope) : "Dashboard"}</h1>
        </div>
        {stats.ok && <StatsBrandSelect brands={stats.brands.filter((b) => canAccessBrand(who, b.slug))} value={scope} allowAll={who.owner} />}
      </div>

      {!stats.ok ? (
        <p className="card">Could not load stats: {stats.error}</p>
      ) : (
        <>
        <section className="card macro" aria-label="Totals across all networks">
          <div className="macro-grid">
            {MACRO.map(([key, label, tone]) => (
              <div className={`macro-cell${tone ? ` ${tone}` : ""}${sum(stats, key) === 0 ? " zero" : ""}`} key={key}>
                <b>{sum(stats, key).toLocaleString("en-US")}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p className="muted">Added up across every network below{scope === "all" ? " and every brand" : ""}. Possible assets counts an asset once for each network it fits.</p>
        </section>
        <div className="net-list">
          {stats.networks.map((net) => (
            <section className="card net" key={net.destination}>
              <header className="net-head">
                <h2>{net.label}</h2>
                <span className="muted">
                  {net.connectedBrands
                    ? `${net.connectedBrands} brand${net.connectedBrands === 1 ? "" : "s"} connected`
                    : "No brand connected"}
                </span>
              </header>
              <div className="net-totals">
                <Cell value={net.totals.possible} label="Possible assets" />
                <Cell value={net.totals.scheduled} label="Approved & scheduled" />
                <Cell value={net.totals.awaiting} label="Awaiting approval" tone="warn" />
                <Cell value={net.totals.failed} label="Failed this month" tone="danger" />
                {PERIODS.map(([key, label]) => <Cell key={key} value={net.totals[key]} label={label} />)}
              </div>
              <div className="fmt-table">
                {net.formats.map((f) => (
                  <div className={`fmt-row status-${f.status}`} key={f.placement} title={f.note ?? undefined}>
                    <div className="fmt-name">
                      <strong>{f.label}</strong>
                      <small>{STATUS_LABEL[f.status] ?? f.status}</small>
                    </div>
                    <Cell value={f.possible} label="Possible" />
                    <Cell value={f.scheduled} label="Scheduled" />
                    <Cell value={f.awaiting} label="Awaiting" tone="warn" />
                    <Cell value={f.failed} label="Failed" tone="danger" />
                    {PERIODS.map(([key, label]) => <Cell key={key} value={f[key]} label={label} />)}
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="muted">Counts use each brand's own time zone. “Possible assets” are approved library assets that fit the format's rules today.</p>
        </div>
        </>
      )}
    </main>
  );
}
