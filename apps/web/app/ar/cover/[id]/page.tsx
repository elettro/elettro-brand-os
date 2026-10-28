import Link from "next/link";
import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arBrand, ArNotConfigured, AR_PUBLIC_BASE } from "@/lib/ar-api";
import { coverScanLinks, pickBrand, publicUrl, qualityBars, type ArDoc } from "@/lib/ar-access";
import { CoverEditor } from "./cover-editor";

export const dynamic = "force-dynamic";

export default async function ArCoverPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const [{ id }, { brand: requested }] = await Promise.all([params, searchParams]);
  const visible = visibleBrands(who, brandConfigs);
  const brand = visible.find((b) => b.id === pickBrand(requested, visible.map((b) => b.id)));
  if (!brand) return <main className="main"><h1>Cover</h1><p className="ar-muted">None of your brands can use AR yet.</p></main>;

  let doc: ArDoc | null = null;
  let problem = "";
  try {
    doc = await arBrand(brand.id);
  } catch (error) {
    problem = error instanceof ArNotConfigured ? "AR is not connected to this environment yet." : "Elettro OS could not reach the AR service.";
  }
  const back = <Link className="ar-muted" href={`/ar?brand=${brand.id}`}>← Experiences</Link>;
  const cover = doc?.triggers?.find((t) => t.id === id);
  if (problem || !doc || doc.entitlement?.arEnabled !== true || !cover) {
    return <main className="main"><div className="eyebrow">AR · Cover</div>{back}<h1>Cover</h1><section className="card ar-note"><b>{problem || "That cover was not found for this brand."}</b></section></main>;
  }
  const rule = (doc.rules || []).find((r) => r.triggerId === id);
  const actions = (doc.actions || []).map((a) => ({ id: a.id, name: a.type === "link" ? a.label || a.name : a.name, type: a.type }));
  const placement = cover.placement || { x: 0, y: 0, s: 1 };

  return <main className="main">
    <div className="eyebrow">AR · Cover</div>
    {back}
    <h1>{cover.name}</h1>
    <p className="ar-muted">{cover.status === "live" ? "Live" : "Draft"} · tracking {qualityBars(cover.quality)}/4 · {cover.target ? "ready to scan" : "no tracking image yet"}</p>
    <CoverEditor
      brand={brand.id}
      coverId={cover.id}
      name={cover.name}
      thumbUrl={publicUrl(AR_PUBLIC_BASE, cover.imageKey || cover.target?.luminanceKey)}
      placement={placement}
      ruleId={rule?.id || null}
      actionIds={(rule?.actionIds || []).filter((a) => actions.some((x) => x.id === a))}
      actions={actions}
      scanLinks={coverScanLinks(doc, brand.id, cover.id, AR_PUBLIC_BASE)}
    />
  </main>;
}
