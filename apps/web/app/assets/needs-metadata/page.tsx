const rows = [
  { file: "live-josh-dean-01.mp4", brand: "stashbox", path: "video/josh-dean/9x16", suggestions: "Josh + Dean · Live performance", status: "AI suggested" },
  { file: "live-josh-dean-02.mp4", brand: "stashbox", path: "video/josh-dean/9x16", suggestions: "Josh + Dean · Live performance", status: "AI suggested" },
  { file: "holiday-storage-01.png", brand: "solarmeister", path: "images/holiday-storage/4x5", suggestions: "Holiday · Storage · Promotional", status: "Needs review" }
];

export default function NeedsMetadataPage() {
  return (
    <main className="main">
      <div className="eyebrow">Review Queue</div>
      <h1>Needs Metadata</h1>
      <p className="muted">Files can safely sit here after a quick dump. Review them individually or apply metadata in bulk later.</p>

      <section className="card" style={{ marginTop: 20, overflowX: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
          <strong>{rows.length} assets waiting</strong>
          <button style={{ border: 0, borderRadius: 9, padding: "9px 12px", background: "var(--accent)", color: "white", fontWeight: 700 }}>Bulk Edit Selected</button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["", "File", "Brand", "Folder hints", "AI suggestions", "State"].map((label) => (
                <th key={label} style={{ textAlign: "left", padding: "10px 8px", borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--muted)" }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.file}>
                <td style={{ padding: 8 }}><input type="checkbox" /></td>
                <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>{row.file}</td>
                <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>{row.brand}</td>
                <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>{row.path}</td>
                <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}>{row.suggestions}</td>
                <td style={{ padding: 8, borderBottom: "1px solid var(--line)" }}><span className="status-chip">{row.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
