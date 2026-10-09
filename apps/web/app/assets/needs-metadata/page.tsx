import Link from "next/link";
import { getAssets } from "@/lib/dev-api";
import { NeedsMetadataClient } from "./needs-metadata-client";

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
            Confirm shared metadata in bulk, mark the batch ready, then only touch exceptions individually.
          </p>
        </div>
        <Link className="status-chip" href="/assets">Back to Asset Library</Link>
      </div>

      <NeedsMetadataClient assets={assets} />
    </main>
  );
}
