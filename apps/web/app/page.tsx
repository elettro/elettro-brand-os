import { BrandSwitcher } from "@/components/brand-switcher";
import { sprintOneBrands } from "@/lib/brands";

const pipeline = [
  ["Dropbox", "Connect one or more brand root folders."],
  ["Ingestion", "Detect files, hashes, paths, file type and technical metadata."],
  ["AI analysis", "Suggest description, topic, product, tags and creative family."],
  ["Human review", "Confirm metadata, eligibility, annual rules and approval."],
  ["Content Pool", "Approved and eligible assets become available to the planner."]
];

export default function DashboardPage() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark">
          Elettro <span>Brand OS</span>
        </div>

        <div className="nav-section">
          <div className="nav-label">Workspace</div>
          <a className="nav-item active" href="/">Dashboard</a>
          <a className="nav-item" href="#">Assets</a>
          <a className="nav-item" href="#">Content Pool</a>
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
          <BrandSwitcher brands={[...sprintOneBrands]} />
        </div>

        <div className="grid stats">
          <div className="card">
            <div className="metric">Brands</div>
            <div className="metric-value">3</div>
          </div>
          <div className="card">
            <div className="metric">Dropbox connections</div>
            <div className="metric-value">0</div>
          </div>
          <div className="card">
            <div className="metric">Assets indexed</div>
            <div className="metric-value">0</div>
          </div>
          <div className="card">
            <div className="metric">Approved in pool</div>
            <div className="metric-value">0</div>
          </div>
        </div>

        <div className="hero">
          <section className="card">
            <span className="status-chip">Foundation active</span>
            <h2>First vertical slice</h2>
            <p className="muted">
              Sprint 1 proves the real workflow before social publishing is connected.
            </p>

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
            <h2>Next integration</h2>
            <p className="muted">
              Dropbox OAuth and PostgreSQL are the next live dependencies.
            </p>
            <div className="pipeline">
              <div className="pipeline-row">
                <strong>SolarMeister</strong>
                <span className="muted">Europe/Berlin</span>
              </div>
              <div className="pipeline-row">
                <strong>Stashbox</strong>
                <span className="muted">America/New_York</span>
              </div>
              <div className="pipeline-row">
                <strong>Elettro</strong>
                <span className="muted">America/New_York</span>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
