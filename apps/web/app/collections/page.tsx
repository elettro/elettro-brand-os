const collections = [
  { name: "Stashbox Does Sublime", brand: "Stashbox", assets: 0, note: "Show/performance collection" },
  { name: "Stashbox Does Dylan", brand: "Stashbox", assets: 0, note: "Show/performance collection" }
];

export default function CollectionsPage() {
  return (
    <main className="main">
      <div className="eyebrow">Asset Relationships</div>
      <h1>Collections</h1>
      <p className="muted">Collections answer “which assets belong together?” They are separate from campaigns and can support several campaigns over time.</p>
      <div className="grid" style={{ marginTop: 20, gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
        {collections.map((collection) => (
          <article className="card" key={collection.name}>
            <div className="eyebrow">{collection.brand}</div>
            <h2>{collection.name}</h2>
            <p className="muted">{collection.note}</p>
            <div className="metric">{collection.assets} indexed assets</div>
          </article>
        ))}
      </div>
    </main>
  );
}
