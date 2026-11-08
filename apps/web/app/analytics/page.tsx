import { redirect } from "next/navigation";
import { authenticated, session } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { reviewCall } from "@/lib/planner-review";
import { ANALYTICS_BRANDS, NETWORK_NAMES, WHY_LABELS, fmt, measuredLabel, watchTime, type BrandAnalytics, type AnalyticsNetwork } from "@/lib/analytics";

// Analytics v1 (Dean, 2026-11-08): owner only (clients never see it), counts and rankings only. Posts are compared within one network,
// ranked by that network's main number with clicks beside it ("sort by clicks" flips it). Grading against each account's normal and
// planner suggestions come later, per account, once it has 30 on-time 7-day snapshots.
const PERIODS = [7, 28, 90];

type Params = { brand?: string; days?: string; sort?: string; net?: string };

function href(base: Params, change: Params) {
  const p = { ...base, ...change };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  return `/analytics?${q}`;
}

async function load(brand: string, days: number, sort: string, summary: boolean) {
  try {
    const r = await reviewCall<BrandAnalytics>({ brand, action: "analytics", days, sort, summary });
    return r.data.ok ? r.data : { ...r.data, brand, failed: r.data.error || "The API did not answer" };
  } catch {
    return { brand, failed: "Elettro OS could not reach the API" } as BrandAnalytics & { failed: string };
  }
}

function Ready({ n }: { n: AnalyticsNetwork["ready"] }) {
  const pct = Math.min(100, Math.round((n.onTime7d / n.of) * 100));
  return <span className="an-ready"><span className="an-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>{n.onTime7d}/{n.of}</span>;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await session())) redirect("/api/auth/login");
  if (!(await authenticated())) redirect("/");
  const params = await searchParams;
  const days = PERIODS.includes(Number(params.days)) ? Number(params.days) : 28;
  const sort = params.sort === "clicks" ? "clicks" : "main";
  const brand = ANALYTICS_BRANDS.includes(params.brand || "") ? params.brand! : "all";
  const base: Params = { brand: brand === "all" ? undefined : brand, days: days === 28 ? undefined : String(days), sort: sort === "main" ? undefined : sort, net: params.net };
  const nameOf = (id: string) => brandConfigs.find((b) => b.id === id)?.name || id;

  const header = <>
    <div className="eyebrow">Intelligence · Analytics</div>
    <h1>{brand === "all" ? "Analytics" : `${nameOf(brand)} analytics`}</h1>
    <p className="muted">What each post did, measured 1 hour, 1 day, 7 days and 30 days after posting. Posts are only compared within one network: a YouTube view, an Instagram view and a Pinterest impression are different things. No grades yet: each account gets them once it has 30 on-time 7-day snapshots.</p>
    <nav className="review-brands" aria-label="Brand">
      <a href={href(base, { brand: undefined })} className={brand === "all" ? "active" : undefined}>All brands</a>
      {ANALYTICS_BRANDS.map((b) => <a key={b} href={href(base, { brand: b, net: undefined })} className={b === brand ? "active" : undefined}>{nameOf(b)}</a>)}
    </nav>
    <div className="an-controls">
      <nav aria-label="Period" className="an-seg">{PERIODS.map((d) => <a key={d} href={href(base, { days: d === 28 ? undefined : String(d) })} aria-current={d === days ? "true" : undefined}>{d} days</a>)}</nav>
      <nav aria-label="Rank by" className="an-seg">
        <a href={href(base, { sort: undefined })} aria-current={sort === "main" ? "true" : undefined}>Rank by views</a>
        <a href={href(base, { sort: "clicks" })} aria-current={sort === "clicks" ? "true" : undefined}>Rank by clicks</a>
      </nav>
    </div>
  </>;

  if (brand === "all") {
    const all = await Promise.all(ANALYTICS_BRANDS.map((b) => load(b, days, sort, true)));
    const ok = all.filter((a): a is BrandAnalytics => !("failed" in a));
    const failed = all.filter((a) => "failed" in a);
    const sum = (f: (a: BrandAnalytics) => number) => ok.reduce((n, a) => n + f(a), 0);
    const topByNet = new Map<string, { post: AnalyticsNetwork["top"][number]; brand: string; label: string }>();
    for (const a of ok) for (const n of a.networks) {
      const p = n.top[0];
      if (!p) continue;
      const score = (x: typeof p) => (sort === "clicks" ? x.metrics.clicks ?? -1 : x.main ?? -1);
      const cur = topByNet.get(n.destination);
      if (!cur || score(p) > score(cur.post)) topByNet.set(n.destination, { post: p, brand: a.brand, label: n.mainLabel });
    }
    const closest = ok.flatMap((a) => a.totals.closest ? [{ ...a.totals.closest, brand: a.brand }] : []).sort((x, y) => y.onTime7d - x.onTime7d)[0];
    return <main className="main">
      {header}
      {failed.length > 0 && <p className="card" style={{ marginTop: 16 }}>Could not load {failed.map((f) => nameOf(f.brand)).join(", ")}.</p>}
      <section className="an-tiles" aria-label="Totals">
        <div className="card"><div className="metric">Posts published</div><div className="metric-value">{fmt(sum((a) => a.totals.posts))}</div><div className="muted">last {days} days</div></div>
        <div className="card"><div className="metric">Measured at least once</div><div className="metric-value">{fmt(sum((a) => a.totals.measured))}</div><div className="muted">{fmt(sum((a) => a.totals.waiting))} waiting (Stories are never measured)</div></div>
        <div className="card"><div className="metric">Link clicks</div><div className="metric-value">{fmt(sum((a) => a.totals.clicks))}</div><div className="muted">Pinterest and LinkedIn report clicks</div></div>
        <div className="card"><div className="metric">Accounts ready to grade</div><div className="metric-value">{sum((a) => a.totals.readyAccounts)} of {sum((a) => a.totals.accounts)}</div><div className="muted">{closest ? `closest: ${nameOf(closest.brand)} ${NETWORK_NAMES[closest.destination] || closest.destination} ${closest.onTime7d}/30` : "none measured on time yet"}</div></div>
      </section>
      <section className="card an-section" aria-labelledby="an-brands">
        <h2 id="an-brands">Brands, side by side</h2>
        <p className="muted">Raw counts; no brand is ranked against another. "Ready to grade" is the brand's account with the most on-time 7-day snapshots.</p>
        <div className="an-scroll"><table className="an-table">
          <thead><tr><th scope="col">Brand</th><th scope="col">Posts</th><th scope="col">Measured</th><th scope="col">Biggest network</th><th scope="col">Clicks</th><th scope="col">Ready to grade</th></tr></thead>
          <tbody>{ok.map((a) => {
            const big = [...a.networks].sort((x, y) => y.total - x.total)[0];
            const best = [...a.networks].sort((x, y) => y.ready.onTime7d - x.ready.onTime7d)[0];
            return <tr key={a.brand}>
              <th scope="row"><a href={href(base, { brand: a.brand, net: undefined })}>{nameOf(a.brand)}</a></th>
              <td>{fmt(a.totals.posts)}</td>
              <td>{fmt(a.totals.measured)}</td>
              <td>{big ? `${NETWORK_NAMES[big.destination] || big.destination} · ${fmt(big.total)} ${big.mainLabel}` : "—"}</td>
              <td>{fmt(a.totals.clicks)}</td>
              <td>{best ? <>{NETWORK_NAMES[best.destination]} <Ready n={best.ready} /></> : "—"}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
      <section className="card an-section" aria-labelledby="an-top">
        <h2 id="an-top">Top post on each network</h2>
        <p className="muted">Any brand, ranked by {sort === "clicks" ? "clicks" : "the network's own main number"} at the latest snapshot.</p>
        <ul className="an-list">{[...topByNet.entries()].map(([net, t]) => <li key={net}>
          <div><strong>{t.post.title || "Untitled post"}</strong><div className="muted">{nameOf(t.brand)} · {NETWORK_NAMES[net] || net} · {measuredLabel(t.post)}</div></div>
          <div className="an-num">{sort === "clicks" ? `${fmt(t.post.metrics.clicks)} clicks` : `${fmt(t.post.main)} ${t.label}`}{t.post.url && <> · <a href={t.post.url} target="_blank" rel="noreferrer">open</a></>}</div>
        </li>)}</ul>
      </section>
    </main>;
  }

  const data = await load(brand, days, sort, false);
  if ("failed" in data) return <main className="main">{header}<p className="card" style={{ marginTop: 16 }}>Could not load analytics: {(data as { failed: string }).failed}</p></main>;
  const nets = data.networks;
  const net = nets.find((n) => n.destination === params.net) || nets[0];
  return <main className="main">
    {header}
    <section className="card an-section" aria-labelledby="an-net">
      <h2 id="an-net">By network</h2>
      <p className="muted">Each row uses that network's own main number. "Typical post" is the median, so one hit doesn't skew it. {fmt(data.totals.posts)} posts, {fmt(data.totals.measured)} measured.</p>
      <div className="an-scroll"><table className="an-table">
        <thead><tr><th scope="col">Network</th><th scope="col">Posts</th><th scope="col">Main number</th><th scope="col">Total</th><th scope="col">Typical post</th><th scope="col">Likes · comments · shares</th><th scope="col">Clicks</th><th scope="col">Ready to grade</th></tr></thead>
        <tbody>{nets.map((n) => <tr key={n.destination}>
          <th scope="row"><a href={href(base, { net: n.destination })}>{NETWORK_NAMES[n.destination] || n.destination}</a></th>
          <td>{fmt(n.posts)}{n.stories ? <span className="muted"> ({n.stories} Stories)</span> : null}</td>
          <td className="muted">{n.mainLabel}</td>
          <td>{fmt(n.total)}</td>
          <td><strong>{fmt(n.typical)}</strong></td>
          <td>{fmt(n.likes)} · {fmt(n.comments)} · {fmt(n.shares)}</td>
          <td>{fmt(n.clicks)}</td>
          <td><Ready n={n.ready} /></td>
        </tr>)}</tbody>
      </table></div>
    </section>

    {net && <>
      <section className="card an-section" aria-labelledby="an-top">
        <h2 id="an-top">Top posts · {NETWORK_NAMES[net.destination] || net.destination}</h2>
        <nav className="an-seg" aria-label="Network">{nets.map((n) => <a key={n.destination} href={href(base, { net: n.destination })} aria-current={n.destination === net.destination ? "true" : undefined}>{NETWORK_NAMES[n.destination] || n.destination}</a>)}</nav>
        <p className="muted">Ranked by {sort === "clicks" ? "clicks" : net.mainLabel} at the latest snapshot. "Caught up" means the numbers were taken late, during the first catch-up run; those never count toward grading. Open a row for why the planner picked it.</p>
        <div className="an-scroll"><table className="an-table">
          <thead><tr><th scope="col">Post</th><th scope="col">Pillar</th><th scope="col">{net.mainLabel}</th><th scope="col">Likes</th><th scope="col">Comments</th><th scope="col">Clicks</th><th scope="col">Watch time</th><th scope="col">Measured</th></tr></thead>
          <tbody>{net.top.map((p) => <tr key={p.id}>
            <th scope="row">
              <details className="an-why">
                <summary><strong>{p.title || "Untitled post"}</strong> <span className="muted">· {p.placement} · {new Date(p.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></summary>
                {p.why ? <dl>
                  {Object.entries(p.why.breakdown).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{WHY_LABELS[k] || k}</dt><dd>{v > 0 ? "+" : ""}{Math.round(v * 10) / 10}</dd></div>)}
                  <div><dt>Score</dt><dd>{p.why.score ?? "—"}</dd></div>
                  {p.why.exploration && <div><dt>Exploration slot</dt><dd>yes</dd></div>}
                </dl> : <p className="muted">Not picked by the planner (hand-written or posted before reasons were kept).</p>}
                {p.url && <a href={p.url} target="_blank" rel="noreferrer">Open the post</a>}
              </details>
            </th>
            <td className="muted">{p.pillar ? p.pillar.replace(/[-_]+/g, " ") : "—"}</td>
            <td><strong>{fmt(p.main)}</strong></td>
            <td>{fmt(p.metrics.likes)}</td>
            <td>{fmt(p.metrics.comments)}</td>
            <td>{fmt(p.metrics.clicks)}</td>
            <td>{watchTime(p.metrics.watchTimeSeconds)}</td>
            <td><span className={p.onTime ? "an-chip ok" : "an-chip late"}>{measuredLabel(p)}</span></td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <div className="an-two">
        <section className="card an-section" aria-labelledby="an-pil">
          <h2 id="an-pil">Pillars · {NETWORK_NAMES[net.destination]}</h2>
          <p className="muted">Typical {net.mainLabel} per post by pillar. Under 10 posts is greyed: too few to trust.</p>
          {(() => {
            const max = Math.max(1, ...(net.pillars || []).map((r) => r.typical ?? 0));
            return <ul className="an-list">{(net.pillars || []).map((r) => <li key={r.label} className={r.trust ? undefined : "an-weak"}>
              <div><strong>{r.label}</strong><span className="an-bar wide" aria-hidden="true"><span style={{ width: `${Math.round(((r.typical ?? 0) / max) * 100)}%` }} /></span></div>
              <div className="an-num">{fmt(r.typical)} {net.mainLabel} · {r.posts} posts</div>
            </li>)}</ul>;
          })()}
        </section>
        <section className="card an-section" aria-labelledby="an-time">
          <h2 id="an-time">Time of day · {NETWORK_NAMES[net.destination]}</h2>
          <p className="muted">Typical {net.mainLabel} by posting time ({brand === "solarmeister" || brand === "neckermann-strom" ? "Berlin" : "New York"}). The planner posts 9 am–9 pm, so there is nothing to compare outside that.</p>
          <ul className="an-list">{(net.times || []).map((t) => <li key={t.label}><strong>{t.label}</strong><div className="an-num">{fmt(t.typical)} · {t.posts} posts</div></li>)}</ul>
          <p className="muted">Early signal while any band has fewer than 30 posts.</p>
        </section>
      </div>
    </>}
    {!net && <p className="card" style={{ marginTop: 16 }}>Nothing published in the last {days} days.</p>}
  </main>;
}
