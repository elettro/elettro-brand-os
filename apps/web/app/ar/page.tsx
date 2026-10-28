import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { arBrand, ArNotConfigured, AR_PUBLIC_BASE } from "@/lib/ar-api";
import { QR_MODE_LABEL, canToggleAr, experienceCards, mainQr, pickBrand, type ArDoc } from "@/lib/ar-access";
import { ArToggle } from "./ar-toggle";

export const dynamic = "force-dynamic";

export default async function ArExperiencesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const { brand: requested } = await searchParams;
  const visible = visibleBrands(who, brandConfigs);
  const brandId = pickBrand(requested, visible.map((b) => b.id));
  const brand = visible.find((b) => b.id === brandId);
  if (!brand) return <main className="main"><div className="eyebrow">AR · Experiences</div><h1>Experiences</h1><p className="ar-muted">None of your brands can use AR yet.</p></main>;

  let doc: ArDoc | null = null;
  let problem = "";
  try {
    doc = await arBrand(brand.id);
  } catch (error) {
    problem = error instanceof ArNotConfigured ? "AR is not connected to this environment yet." : "Elettro OS could not reach the AR service.";
  }
  const enabled = doc?.entitlement?.arEnabled === true;
  const owner = canToggleAr(who);
  // A client whose brand has AR off sees a plain line; the nav hides the section for them, this covers a typed address.
  const cards = doc && enabled ? experienceCards(doc, AR_PUBLIC_BASE) : [];
  const main = doc && enabled ? mainQr(doc) : null;
  const address = `${AR_PUBLIC_BASE}/${brand.id}`;

  return <main className="main">
    <div className="eyebrow">AR · Experiences</div>
    <div className="ar-head">
      <div>
        <h1>Experiences</h1>
        <p className="ar-muted">Turn printed artwork into a browser experience. Everything here is for {brand.name}.</p>
      </div>
      {enabled && <a className="ar-btn" href={address} target="_blank" rel="noreferrer">Open the public scanner ↗</a>}
    </div>

    {problem && <section className="card ar-note"><b>{problem}</b></section>}

    {!problem && !enabled && <section className="card ar-note">
      <b>AR isn’t enabled for {brand.name}</b>
      <p className="ar-muted">Turn it on to register artwork and make QR experiences for this brand.</p>
      {owner ? <ArToggle brand={brand.id} brandName={brand.name} enabled={false} /> : <p className="ar-muted">Ask Elettro to switch it on.</p>}
    </section>}

    {enabled && <>
      {cards.length === 0 && <section className="card ar-note"><b>No covers registered yet</b><p className="ar-muted">Covers and their videos are added through chat, or with New experience once that page is built.</p></section>}
      <div className="ar-grid">
        {cards.map((c) => <article className="card ar-card" key={c.id}>
          <div className="ar-thumb">
            {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <span className="ar-muted">No image</span>}
            <span className={`ar-badge ${c.live ? "live" : "draft"}`}>{c.live ? "Live" : "Draft"}</span>
          </div>
          <h3>{c.name}</h3>
          <div className={c.hasActions ? "ar-muted" : "ar-warn"}>{c.hasActions ? "" : "⚠ "}{c.summary}</div>
          <div className="ar-muted ar-small">
            Tracking <span className="ar-meter" aria-label={`${c.qualityBars} of 4`}>{[1, 2, 3, 4].map((n) => <i key={n} className={n <= c.qualityBars ? "on" : ""} />)}</span>
            {c.sets.length > 0 && <> · in {c.sets.join(", ")}</>}
          </div>
        </article>)}
      </div>

      <section className="card ar-qr">
        <div>
          <div className="ar-muted ar-small">Main printed code{main ? ` · ${QR_MODE_LABEL[main.mode] || main.mode}` : ""}</div>
          <b>{main ? (main.mode === "url" ? main.url : main.name) : "No main code yet"}</b>
          <div className="ar-muted ar-small">{address}</div>
          <div className="ar-muted ar-small">The printed code stays the same; only where it opens changes.</div>
        </div>
        {owner && <ArToggle brand={brand.id} brandName={brand.name} enabled />}
      </section>
    </>}
  </main>;
}
