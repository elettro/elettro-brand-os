import Link from "next/link";
import { getAssets } from "@/lib/dev-api-server";
import { requireSession, scopeOf } from "@/lib/page-guards";
import { AssetLibraryClient } from "./asset-library-client";

export default async function AssetsPage() {
  const who = await requireSession();
  let assets: Awaited<ReturnType<typeof getAssets>>["assets"] = [];
  try {
    assets = (await getAssets(scopeOf(who))).assets;
  } catch {
    assets = [];
  }

  return (
    <main className="main">
      <div className="topbar">
        <div>
          <div className="eyebrow">Content</div>
          <h1>Asset Library</h1>
          <p className="muted">Live indexed assets from Dropbox and Shopify. Source files remain in their original libraries.</p>
        </div>
        {who.owner && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="status-chip" href="/assets/shopify">Shopify</Link>
          <Link className="status-chip" href="/assets/needs-metadata">Needs Metadata</Link>
          <Link className="status-chip" href="/assets/add">Add Assets</Link>
        </div>}
      </div>

      <AssetLibraryClient assets={assets} />
    </main>
  );
}
