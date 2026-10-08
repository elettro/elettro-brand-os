const products = [
  { name: "Stashbox Logo Tee", type: "Apparel", media: 6 },
  { name: "No Problem Hat", type: "Apparel", media: 5 },
  { name: "Stashbox Sticker Pack", type: "Accessories", media: 4 },
  { name: "Live Show Poster", type: "Digital", media: 3 }
];

const media = [
  { name: "logo_tee_front.jpg", kind: "Image", size: "3000 × 3000", role: "Main image" },
  { name: "logo_tee_back.jpg", kind: "Image", size: "3000 × 3000", role: "Back view" },
  { name: "logo_tee_lifestyle_01.jpg", kind: "Image", size: "3000 × 3000", role: "Lifestyle" },
  { name: "logo_tee_video.mp4", kind: "Video", size: "1920 × 1080", role: "Product video" }
];

export default function ShopifyAssetsPage() {
  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Asset Source · Shopify</div>
          <h1>Shopify Assets</h1>
          <p className="muted">
            Browse and index Shopify-hosted product media without copying it into Dropbox.
          </p>
        </div>
        <span className="status-chip">Source of truth: Shopify</span>
      </div>

      <div className="hero" style={{ gridTemplateColumns: "320px minmax(0,1fr)" }}>
        <section className="card">
          <div className="eyebrow">Products</div>
          <h2>Stashbox Store</h2>
          <div className="pipeline">
            {products.map((product) => (
              <button key={product.name} type="button" className="pipeline-row" style={{ textAlign: "left", width: "100%", cursor: "pointer" }}>
                <strong>{product.name}</strong>
                <span className="muted">{product.type} · {product.media} media files</span>
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="topbar" style={{ marginBottom: 14 }}>
            <div>
              <div className="eyebrow">Product Media</div>
              <h2 style={{ margin: "4px 0 0" }}>Stashbox Logo Tee</h2>
            </div>
            <button type="button" style={{ border: "1px solid var(--line)", background: "white", borderRadius: 9, padding: "9px 12px", fontWeight: 700 }}>
              Sync Now
            </button>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
            {media.map((item) => (
              <article className="card" key={item.name}>
                <div style={{ aspectRatio: "1 / 1", borderRadius: 10, background: "var(--panel-soft)", display: "grid", placeItems: "center", border: "1px solid var(--line)" }}>
                  <span className="muted">{item.kind} preview</span>
                </div>
                <h3 style={{ marginBottom: 4 }}>{item.name}</h3>
                <div className="muted">{item.size}</div>
                <div style={{ marginTop: 8 }}><span className="status-chip">{item.role}</span></div>
              </article>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16, background: "var(--panel-soft)" }}>
            <strong>How Shopify assets work</strong>
            <p className="muted">
              Brand OS stores the Shopify media ID, product association, URL/reference, metadata, and usage history.
              The original file stays in Shopify. No Dropbox duplicate is created.
            </p>
            <button type="button" style={{ border: 0, borderRadius: 9, padding: "10px 14px", background: "var(--accent)", color: "white", fontWeight: 700 }}>
              Make Selected Available to Content Pool
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
