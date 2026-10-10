import { publishingDestinations } from "@/lib/publishing-destinations";

const fields = [
  "Product / Topic",
  "Campaign",
  "Creative Family",
  "Content Group",
  "Eligibility Type",
  "Eligible From",
  "Eligible Until",
  "Annual Repeat",
  "Contains Specific Pricing",
  "Priority",
  "Creative Notes"
];

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="main">
      <div className="eyebrow">Asset Review</div>
      <h1>Asset {id}</h1>
      <p className="muted">This is the review/edit shell that will be backed by PostgreSQL after live services are connected.</p>

      <section className="card" style={{ marginTop: 20 }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {fields.map((field) => (
            <label key={field} style={{ display: "grid", gap: 6 }}>
              <span className="metric">{field}</span>
              <input disabled placeholder="Connect database to edit" style={{ padding: 10, border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel-soft)" }} />
            </label>
          ))}
        </div>
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Allowed Destinations</h2>
        <p className="muted">Social channels, websites and RSS feeds are eligible destination types. Specific brand accounts, sites and feeds require configuration before publishing. Controls will become editable when the asset database is connected.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          {publishingDestinations.map((destination) => (
            <label key={destination.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
              <input type="checkbox" disabled aria-label={destination.label} />
              <span>{destination.label}</span><small className="muted">({destination.kind})</small>
            </label>
          ))}
        </div>
      </section>
    </main>
  );
}
