const presets = [
  {
    name: "Stashbox Does Sublime · Evergreen Performance",
    brand: "Stashbox",
    summary: "Live performance · Evergreen · Normal priority · all social destinations"
  },
  {
    name: "SolarMeister Holiday · Annual",
    brand: "SolarMeister",
    summary: "Promotional · Annual Sep 15–Dec 25 · High priority"
  }
];

export default function PresetsPage() {
  return (
    <main className="main">
      <div className="eyebrow">Reusable Metadata</div>
      <h1>Presets</h1>
      <p className="muted">Set common metadata once and apply it to future batches. Individual assets can still override any field.</p>
      <div className="grid" style={{ marginTop: 20 }}>
        {presets.map((preset) => (
          <article className="card" key={preset.name}>
            <div className="eyebrow">{preset.brand}</div>
            <h2>{preset.name}</h2>
            <p className="muted">{preset.summary}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
