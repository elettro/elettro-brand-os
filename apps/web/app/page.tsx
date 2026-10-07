import Link from "next/link";
import { BrandSwitcher } from "@/components/brand-switcher";
import { sprintOneBrands } from "@/lib/brands";

const pipeline = [
  ["Dropbox", "One connected Dropbox account with six mapped brand roots."],
  ["Ingestion", "Detect files, hashes, paths, file type and technical metadata."],
  ["AI analysis", "Suggest description, topic, product, tags and creative family."],
  ["Human review", "Confirm metadata, eligibility, annual rules and approval."],
  ["Content Pool", "Approved and eligible assets become available to the planner."]
];

export default function DashboardPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark">Elettro <span>Brand OS</span></div>

        <div className="nav-section">
          <div className="nav-label">Workspace</div>
          <Link className="nav-item active" href="/">Dashboard</Link>
          <Link className="nav-item" href="/assets">Assets</Link>
          <Link className="nav-item" href="/content-pool">Content Pool</Link>
          <a className="nav-item" href="#">Calendar</a>
        </div>

        <div className="nav-section">
          <div className="nav-label">Publishing</div>
          <a className="nav-item" href="#">Planner</a>
          <a className="nav-item" href="#">Review</a>
          <a className="nav-item" href="#">History</a>
        </div>

        <div className="nav-section">
          <div className="nav-label">Intelligence</div>
          <a className="nav-item" href="#">Chat</a>
          <a className="nav-item" href="#">Analytics</a>
          <a className="nav-item" href="#">Knowledge</a>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <div className="eyebrow">Publishing Engine · Sprint 1</div>
            <h1>Create. Approve. The engine distributes.</h1>
          </div>
          <BrandSwitcher brands={sprintOneBrands} />
        </div>

        <div className="grid stats">
          <div className="card"><div className="metric">Brands</div><div className="metric-value">6</div></div>
          <div className="card"><div className="metric">Dropbox accounts</div><div className="metric-value">1</div></div>
          <div className="card"><div className="metric">Assets indexed</div><div className="metric-value">0</div></div>
          <div className="card"><div className="metric">Approved in pool</div><div className="metric-value">0</div></div>
        </div>

        <div className="hero">
          <section className="card">
            <span className="status-chip">Sprint 1 implementation</span>
            <h2>First vertical slice</h2>
            <p className="muted">The app shell, asset review screens, eligibility engine and Content Pool logic are now being wired before live Dropbox credentials.</p>
            <div className="pipeline">
              {pipeline.map(([title, description], index) => (
                <div className="pipeline-row" key={title}>
                  <strong>{index + 1}. {title}</strong>
                  <span className="muted">{description}</span>
                </div>
              ))}
            </div>
          </section>

          <aside className="card">
            <h2>Brand roots</h2>
            <p className="muted">Each root and all of its subfolders map to one brand automatically.</p>
            <div className="pipeline">
              {sprintOneBrands.map((brand) => (
                <div className="pipeline-row" key={brand.id}>
                  <strong>{brand.name}</strong>
                  <span className="muted">{brand.timezone}</span>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
