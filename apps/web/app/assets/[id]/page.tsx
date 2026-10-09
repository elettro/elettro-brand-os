import { notFound } from "next/navigation";
import { getAsset } from "@/lib/dev-api";
import { AssetDetailClient } from "./asset-detail-client";

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const response = await getAsset(id);
    return <AssetDetailClient asset={response.asset} />;
  } catch {
    notFound();
  }
}
