import { getContentPool } from "@/lib/dev-api-server";
import { canAccessBrand } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { requireSession, scopeOf } from "@/lib/page-guards";
import { ContentPoolClient } from "./content-pool-client";

export default async function ContentPoolPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await requireSession();
  const { brand: requested, stock } = await searchParams;
  // The header brand switcher sets ?brand=. A brand the user may not see falls back to everything they can see.
  const brand = brandConfigs.find((b) => b.id === requested && canAccessBrand(who, b.id));
  const showStock = stock === "1";
  const scope = brand ? [brand.id] : scopeOf(who);
  let assets: Awaited<ReturnType<typeof getContentPool>>["assets"] = [];
  try {
    assets = (await getContentPool(scope, showStock)).assets;
  } catch {
    assets = [];
  }
  const base = brand ? `/content-pool?brand=${brand.id}` : "/content-pool";
  const label = brand ? brand.name : "all brands";

  return (
    <main className="main">
      <div className="eyebrow">Publishing</div>
      <h1>Content Pool</h1>
      <p className="muted">Only approved, ready, currently eligible content belongs here.</p>
      <nav className="review-brands" aria-label="Content source">
        <a href={base} className={showStock ? undefined : "active"}>{brand ? `${brand.name} assets` : "Brand assets"}</a>
        <a href={`${base}${brand ? "&" : "?"}stock=1`} className={showStock ? "active" : undefined}>Stock Gallery Assets for {label}</a>
      </nav>
      <ContentPoolClient assets={assets} />
    </main>
  );
}
