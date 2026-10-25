import { authenticated } from "@/lib/cognito-auth";
import { redirect } from "next/navigation";
import { StatsBrandSelect } from "@/components/stats-brand-select";
import { plannerCall, type DashboardStats, type StatCounts } from "@/lib/planner";

const STATUS_LABEL: Record<string, string> = {
  live: "Live", planning: "Planning", review: "In app review", integration: "Not connected"
};

// Per-format cells shown in every row, in reading order.
const PERIODS: Array<[keyof StatCounts, string]> = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["total", "All time"]];

function Cell({ value, label, tone }: { value: number; label: string; tone?: "warn" | "danger" }) {
  return (
    <div className={`stat-cell${value === 0 ? " zero" : ""}${tone ? ` ${tone}` : ""}`}>
      <b>{value.toLocaleString("en-US")}</b>
      <span>{label}</span>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await authenticated())) redirect("/welcome");
  const scope = (await searchParams).brand || "all";
  const stats = await plannerCall<DashboardStats>({ action: "stats", brandSlug: scope });

  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Publishing · Dashboard</div>
          <h1>{stats.ok ? (scope === "all" ? "All brands" : stats.brands.find((b) => b.slug === scope)?.name ?? scope) : "Dashboard"}</h1>
        </div>
        {stats.ok && <StatsBrandSelect brands={stats.brands} value={scope} />}
      </div>

      {!stats.ok ? (
        <p className="card">Could not load stats: {stats.error}</p>
      ) : (
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
      )}
    </main>
  );
}
