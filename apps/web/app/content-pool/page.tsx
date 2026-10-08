import { getContentPool } from "@/lib/dev-api";

export default async function ContentPoolPage() {
  let approved: Awaited<ReturnType<typeof getContentPool>>["assets"] = [];
  try {
    approved = (await getContentPool()).assets;
  } catch {
    approved = [];
  }

  return (
    <main className="main">
      <div className="eyebrow">Publishing</div>
      <h1>Content Pool</h1>
      <p className="muted">Only approved, ready, currently eligible content belongs here.</p>

      <div className="grid" style={{ marginTop: 20 }}>
        {approved.map((asset) => (
          <article className="card" key={asset.id}>
            <strong>{asset.filename}</strong>
            <p className="muted">{asset.brandName} · {asset.kind} · {asset.contentGroup ?? "—"}</p>
            <span className="status-chip">{asset.eligibilityType ?? "evergreen"}</span>
          </article>
        ))}
      </div>
    </main>
  );
}
