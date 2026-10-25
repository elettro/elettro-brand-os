import { notFound } from "next/navigation";
import { getAsset } from "@/lib/dev-api-server";
import { brandConfigs } from "@/lib/brand-config";
import { requireSession, scopeOf } from "@/lib/page-guards";
import { AssetDetailClient } from "./asset-detail-client";
import { ClientAssetView } from "./client-asset-view";

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const who = await requireSession();
  const { id } = await params;

  try {
    const response = await getAsset(id, scopeOf(who));
    if (!who.owner) {
      const brands = brandConfigs.filter((b) => who.brands.includes(b.id)).map((b) => ({ id: b.id, name: b.name }));
      return <ClientAssetView asset={response.asset} brands={brands} />;
    }
    return <AssetDetailClient asset={response.asset} />;
  } catch {
    notFound();
  }
}
