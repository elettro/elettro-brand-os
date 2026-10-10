import Link from "next/link";
import { mockAssets } from "@/lib/mock-assets";

export default function AssetsPage() {
  return (
    <main className="main">
      <div className="eyebrow">Content</div>
      <h1>Asset Library</h1>
      <p><Link href="/assets/add" style={{ color: "#e8590c", fontWeight: 700 }}>+ Add Assets · Smart Batch Intake</Link></p>
      <p className="muted">Files detected from configured Dropbox brand roots will appear here for review.</p>

      <div className="card" style={{ marginTop: 20, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["File", "Brand", "Type", "Content Group", "Eligibility", "Approval", "Status"].map((label) => (
                <th key={label} style={{ textAlign: "left", padding: "10px 8px", borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--muted)" }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mockAssets.map((asset) => (
              <tr key={asset.id}>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.filename}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.brandId}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.kind}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.contentGroup}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.eligibility}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.approval}</td>
                <td style={{ padding: "12px 8px", borderBottom: "1px solid var(--line)" }}>{asset.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
