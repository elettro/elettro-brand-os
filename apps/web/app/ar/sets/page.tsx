import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arBrand, ArNotConfigured, AR_PUBLIC_BASE } from "@/lib/ar-api";
import { pickBrand, qrAddress, setReadiness, type ArDoc } from "@/lib/ar-access";
import { SetsManager } from "./sets-manager";

export const dynamic = "force-dynamic";

export default async function ArSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const { brand: requested } = await searchParams;
  const visible = visibleBrands(who, brandConfigs);
  const brand = visible.find((b) => b.id === pickBrand(requested, visible.map((b) => b.id)));
  if (!brand) return <main className="main"><div className="eyebrow">AR · Scan sets</div><h1>Scan sets</h1><p className="ar-muted">None of your brands can use AR yet.</p></main>;

  let doc: ArDoc | null = null;
  let problem = "";
  try {
    doc = await arBrand(brand.id);
  } catch (error) {
    problem = error instanceof ArNotConfigured ? "AR is not connected to this environment yet." : "Elettro OS could not reach the AR service.";
  }
  const enabled = doc?.entitlement?.arEnabled === true;
  const covers = (doc?.triggers || []).map((t) => ({ id: t.id, name: t.name }));
  const sets = (doc?.sets || []).map((s) => ({
    id: s.id, name: s.name, slug: s.slug, triggerIds: s.triggerIds || [],
    readiness: setReadiness(doc!, s),
    addresses: (doc?.qrs || []).filter((q) => q.mode === "scanner" && q.setId === s.id).map((q) => qrAddress(AR_PUBLIC_BASE, brand.id, q))
  }));

  return <main className="main">
    <div className="eyebrow">AR · Scan sets</div>
    <h1>Scan sets</h1>
    <p className="ar-muted">Choose which covers one scanner recognizes. A scanner loads only its own set.</p>
    {problem && <section className="card ar-note"><b>{problem}</b></section>}
    {!problem && !enabled && <section className="card ar-note"><b>AR isn’t enabled for {brand.name}</b><p className="ar-muted">Switch it on from Experiences first.</p></section>}
    {enabled && <SetsManager brand={brand.id} covers={covers} sets={sets} />}
  </main>;
}
