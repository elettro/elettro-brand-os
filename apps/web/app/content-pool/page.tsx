import { getContentPool } from "@/lib/dev-api-server";
import { requireSession, scopeOf } from "@/lib/page-guards";
import { ContentPoolClient } from "./content-pool-client";

export default async function ContentPoolPage() {
  const who = await requireSession();
  let approved: Awaited<ReturnType<typeof getContentPool>>["assets"] = [];
  try {
    approved = (await getContentPool(scopeOf(who))).assets;
  } catch {
    approved = [];
  }

  return (
    <main className="main">
      <div className="eyebrow">Publishing</div>
      <h1>Content Pool</h1>
      <p className="muted">Only approved, ready, currently eligible content belongs here.</p>
      <ContentPoolClient assets={approved} />
    </main>
  );
}
