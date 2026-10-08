import Link from "next/link";
import { getAssets } from "@/lib/dev-api";

export default async function AssetsPage() {
  let assets: Awaited<ReturnType<typeof getAssets>>["assets"] = [];
  try {
    assets = (await getAssets()).assets;
  } catch {
    assets = [];
  }
  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Content</div>
          <h1>Asset Library</h1>
          <p className="muted">One catalog, multiple source libraries. Dropbox files stay in Dropbox; Shopify media stays in Shopify.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="status-chip" href="/assets/shopify">Shopify</Link>
          <Link className="status-chip" href="/assets/needs-metadata">Needs Metadata</Link>
          <Link className="status-chip" href="/assets/add">Add Assets</Link>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginBottom: 18 }}>
        <Link className="card" href="/assets" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="eyebrow">All Sources</div>
          <h2>All Assets</h2>
          <p className="muted">Unified catalog across Dropbox, Shopify, and future sources.</p>
        </Link>
        <div className="card">
          <div className="eyebrow">Creator Library</div>
          <h2>Dropbox</h2>
          <p className="muted">Human-organized production assets. Files remain in Dropbox.</p>
        </div>
        <Link className="card" href="/assets/shopify" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="eyebrow">Commerce Library</div>
          <h2>Shopify</h2>
          <p className="muted">Product media indexed from Shopify without copying files into Dropbox.</p>
        </Link>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["File", "Brand", "Type", "Content Group", "Eligibility", "Approval", "Status"].map((label) => (
                <th key={label} style={{ textAlign: "left", padding: "10px 8px", borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--muted)" }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.id}>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>
                  <Link href={`/assets/${asset.id}`}>{asset.filename}</Link>
                </td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.brandName}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.kind}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.contentGroup ?? "—"}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.aspectRatioLabel ?? "—"}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.approvalStatus ?? "—"}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.ingestStatus ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
