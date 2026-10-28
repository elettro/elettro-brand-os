import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arBrand, ArNotConfigured, AR_PUBLIC_BASE } from "@/lib/ar-api";
import { pickBrand, qrAddress, qrDestination, type ArDoc } from "@/lib/ar-access";
import { QrManager } from "./qr-manager";

export const dynamic = "force-dynamic";

export default async function ArQrPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const { brand: requested } = await searchParams;
  const visible = visibleBrands(who, brandConfigs);
  const brand = visible.find((b) => b.id === pickBrand(requested, visible.map((b) => b.id)));
  if (!brand) return <main className="main"><div className="eyebrow">AR · QR codes</div><h1>QR codes</h1><p className="ar-muted">None of your brands can use AR yet.</p></main>;

  let doc: ArDoc | null = null;
  let problem = "";
  try {
    doc = await arBrand(brand.id);
  } catch (error) {
    problem = error instanceof ArNotConfigured ? "AR is not connected to this environment yet." : "Elettro OS could not reach the AR service.";
  }
  const enabled = doc?.entitlement?.arEnabled === true;
  const qrs = (doc?.qrs || []).map((q) => ({ ...q, address: qrAddress(AR_PUBLIC_BASE, brand.id, q), destination: qrDestination(q, doc?.sets || [], doc?.actions || []) }));

  return <main className="main">
    <div className="eyebrow">AR · QR codes</div>
    <h1>QR codes</h1>
    <p className="ar-muted">One printed code. Change where it opens, anytime. A printed address never changes.</p>
    {problem && <section className="card ar-note"><b>{problem}</b></section>}
    {!problem && !enabled && <section className="card ar-note"><b>AR isn’t enabled for {brand.name}</b><p className="ar-muted">Switch it on from Experiences first.</p></section>}
    {enabled && <QrManager brand={brand.id} qrs={qrs} sets={(doc?.sets || []).map((s) => ({ id: s.id, name: s.name }))} actions={(doc?.actions || []).map((a) => ({ id: a.id, name: a.name }))} />}
  </main>;
}
