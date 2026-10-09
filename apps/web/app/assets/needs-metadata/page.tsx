import Link from "next/link";
import { getAssets } from "@/lib/dev-api";

export default async function NeedsMetadataPage() {
  let assets: Awaited<ReturnType<typeof getAssets>>["assets"] = [];
  try {
    assets = (await getAssets()).assets.filter(
      (asset) => asset.ingestStatus === "raw" || asset.ingestStatus === "needs_metadata"
    );
  } catch {
    assets = [];
  }

  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Review Queue</div>
          <h1>Needs Metadata</h1>
          <p className="muted">
            Dropbox folder structure becomes a suggestion layer here. Confirm shared meaning once, then only touch exceptions.
          </p>
        </div>
        <Link className="status-chip" href="/assets">Back to Asset Library</Link>
      </div>

      <section className="card" style={{ marginTop: 20, overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
          <strong>{assets.length} assets waiting</strong>
          <span className="muted">Folder hints are suggestions, not authoritative metadata.</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["File", "Brand", "Folder", "Topic / subject hint", "Ratio hint", "Approval", "State"].map((label) => (
                <th
                  key={label}
                  style={{
                    textAlign: "left",
                    padding: "10px 8px",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 12,
                    color: "var(--muted)"
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const hints = asset.folderSuggestions || {};
              return (
                <tr key={asset.id}>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)", maxWidth: 360 }}>
                    <Link href={`/assets/${asset.id}`} style={{ overflowWrap: "anywhere" }}>{asset.filename}</Link>
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>{asset.brandName}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    {hints.folderPath || asset.sourcePath || "—"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    {hints.topicHint || "—"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    {hints.aspectRatioLabel || asset.aspectRatioLabel || "—"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    <span className="status-chip">{asset.approvalStatus || "—"}</span>
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid var(--line)" }}>
                    <span className="asset-small-chip">{asset.enrichmentStatus || asset.ingestStatus || "—"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {assets.length === 0 && (
          <div style={{ padding: "24px 0" }}>
            <strong>No assets are currently waiting for metadata.</strong>
          </div>
        )}
      </section>
    </main>
  );
}
