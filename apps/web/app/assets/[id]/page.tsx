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
  "Allowed Destinations",
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
    </main>
  );
}
