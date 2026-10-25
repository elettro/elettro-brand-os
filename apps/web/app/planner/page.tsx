import Link from "next/link";
import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { canAccessBrand, visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { plannerCall, type PlannedPost } from "@/lib/planner";
import { approveWeek, requestReplan, saveCadence } from "./actions";

const NETWORK: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok",
  x: "X", threads: "Threads", linkedin: "LinkedIn", pinterest: "Pinterest"
};
const SHORT: Record<string, string> = { youtube: "YT", instagram: "IG", facebook: "FB", tiktok: "TT", x: "X", threads: "TH", linkedin: "LI" };
// Order of the status counts, and what each one means to the owner.
const STATUSES: Array<[string, string]> = [
  ["planned", "Needs approval"], ["approved", "Approved"], ["publishing", "Uploading"],
  ["published", "Published"], ["failed", "Failed"], ["missed", "Missed"]
];

const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function byDay(posts: PlannedPost[], timeZone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const groups = new Map<string, PlannedPost[]>();
  for (const p of posts) {
    const key = day.format(new Date(p.scheduledFor));
    groups.set(key, [...(groups.get(key) || []), p]);
  }
  return groups;
}

export default async function PlannerPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const params = await searchParams;
  const brandSlug = params.brand || (who.owner ? "stashbox" : who.brands[0]);
  if (!canAccessBrand(who, brandSlug)) redirect("/planner?brand=" + encodeURIComponent(who.brands[0]));
  const week = await plannerCall({ action: "view", brandSlug, weekStart: params.week });
  const brandTabs = (
    <div className="planner-tabs">
      {visibleBrands(who, brandConfigs).map((b) => (
        <Link key={b.id} href={`/planner?brand=${b.id}`} className={b.id === brandSlug ? "active" : ""}>{b.name}</Link>
      ))}
    </div>
  );
  if (!week.ok) {
    return <main className="main">
      <div className="eyebrow">Publishing · Planner</div>
      <h1>Planner</h1>
      {brandTabs}
      <p className="card">Could not load the planner: {week.error}</p>
    </main>;
  }

  const time = new Intl.DateTimeFormat("en-US", { timeZone: week.timeZone, hour: "numeric", minute: "2-digit" });
  const dayLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i));
  const groups = byDay(week.posts, week.timeZone);
  const count = (status: string) => week.posts.filter((p) => p.status === status).length;
  const planned = count("planned");
  const totalPerWeek = week.rules.reduce((n, r) => n + r.postsPerWeek, 0);
  const hidden = { brand: brandSlug, week: week.weekStart };

  return <main className="main">
    <div className="eyebrow">Publishing · Planner</div>
    <h1>Planner</h1>
    <p className="muted">The planner fills the next two weeks automatically. Approve a week and its posts go out at their times. YouTube is live; other networks wait for their connections.</p>
    {brandTabs}
    {params.msg && <p className="card planner-msg">{params.msg}</p>}

    <section className="card planner-week">
      <div className="planner-week-head">
        <Link className="status-chip" href={`/planner?brand=${brandSlug}&week=${addDays(week.weekStart, -7)}`}>← Prev</Link>
        <h2>Week of {dayLabel(week.weekStart)}</h2>
        <Link className="status-chip" href={`/planner?brand=${brandSlug}&week=${addDays(week.weekStart, 7)}`}>Next →</Link>
      </div>
      <div className="planner-counts">
        {STATUSES.map(([status, label]) => (
          <span key={status} className={`planner-count s-${status}`}><b>{count(status)}</b> {label}</span>
        ))}
      </div>
      <div className="planner-actions">
        <form action={approveWeek}>
          {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <button className="planner-primary" disabled={!planned}>Approve {planned} posts</button>
        </form>
        <form action={requestReplan}>
          {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <button className="planner-secondary" disabled={week.replanRequested}>
            {week.replanRequested ? "Re-plan queued" : "Re-plan this week"}
          </button>
        </form>
      </div>
      {!week.posts.length && <p className="muted">Nothing planned for this week yet. The planner fills it within 15 minutes once it is one of the next two weeks.</p>}
      <div className="planner-days">
        {days.map((ymd) => (
          <div className="planner-day" key={ymd}>
            <div className="planner-day-label">{dayLabel(ymd)} <span>{(groups.get(ymd) || []).length}</span></div>
            {(groups.get(ymd) || []).map((p) => (
              <div key={p.id} className={`planner-post s-${p.status}`} title={`${p.title || p.filename}${p.error ? `\n${p.error}` : ""}`}>
                <span className="planner-time">{time.format(new Date(p.scheduledFor))}</span>
                <span className={`planner-net n-${p.destination}`}>{SHORT[p.destination] || p.destination} {p.placement}</span>
                {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title || p.filename}</a> : <span className="planner-file">{p.title || p.filename}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>

    <section className="card" style={{ marginTop: 16 }}>
      <h2>Cadence</h2>
      <p className="muted">{totalPerWeek} posts a week across {week.rules.length} formats. Changes apply to weeks planned from now on.</p>
      <form action={saveCadence}>
        {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <div className="planner-table-wrap">
          <table className="planner-table">
            <thead><tr><th>Network</th><th>Format</th><th>Account</th><th>Posts / week</th><th>Per day</th><th>Window</th></tr></thead>
            <tbody>
              {week.rules.map((r) => (
                <tr key={r.id}>
                  <td>{NETWORK[r.destination] || r.destination} {r.connected ? <span className="planner-live">● live</span> : <span className="muted">○ not connected</span>}</td>
                  <td>{r.placement}</td>
                  <td>{r.accountName}</td>
                  <td><input type="number" min={0} max={200} name={`ppw:${r.id}`} defaultValue={r.postsPerWeek} /></td>
                  <td className="muted">{(r.postsPerWeek / 7).toFixed(1)}</td>
                  <td className="muted">
                    {r.preferredDays?.length ? `${r.preferredDays.join(", ")} · ` : ""}
                    {r.preferredStartTime || "12:00"}{r.preferredEndTime ? `–${r.preferredEndTime}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="planner-primary" style={{ marginTop: 12 }}>Save cadence</button>
      </form>
    </section>
  </main>;
}
