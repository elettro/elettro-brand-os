"use client";

import { useEffect, useState } from "react";
import { brandConfigs } from "@/lib/brand-config";
import { LINK_HOSTS } from "@/lib/link-hosts";
import "./link-in-bio.css";

type BioLink = { id: string; title: string; url: string; enabled: boolean };
type BioPage = { heading: string; description: string; accent: string; links: BioLink[] };
const suggestions: Record<string, string> = {
  solarmeister: "go.solarmeister-shop.de",
  "neckermann-strom": "go.neckermann-strom.de"
};
const initial: Record<string, BioPage> = {
  stashbox: { heading: "STASHBOX", description: "Music. Videos. Shows. Merch.", accent: "#13c9c5", links: [
    { id: "radio", title: "Listen to Stashbox Radio", url: "https://stashbox.com/radio", enabled: true },
    { id: "videos", title: "Watch on YouTube", url: "https://www.youtube.com/@Stashboxband", enabled: true },
    { id: "store", title: "Shop Stashbox", url: "https://stashbox.ai", enabled: true }
  ] },
  solarmeister: { heading: "SOLARMEISTER", description: "Deine Energie. Deine Entscheidung.", accent: "#19b68b", links: [
    { id: "shop", title: "Zum Onlineshop", url: "https://solarmeister-shop.de", enabled: true }
  ] },
  "neckermann-strom": { heading: "NECKERMANN STROM", description: "Energie. Angebote. Informationen.", accent: "#29a66a", links: [
    { id: "home", title: "Strompreise vergleichen", url: "https://neckermann-strom.de", enabled: true }
  ] }
};
const defaultPage = (id: string): BioPage => initial[id] ?? { heading: brandConfigs.find(b=>b.id===id)?.name ?? id, description: "Our latest links", accent: "#13c9c5", links: [] };
const validUrl = (url: string) => { try { return ["https:","http:"].includes(new URL(url).protocol); } catch { return false; } };

export default function BioEditor({ allowedBrands, initialBrand }: { allowedBrands: Array<{id: string; name: string}>; initialBrand: string }) {
  const [brand, setBrand] = useState(initialBrand);
  const [page, setPage] = useState<BioPage>(defaultPage("stashbox"));
  const [saved, setSaved] = useState(true);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"editor" | "dns">("editor");
  const [view, setView] = useState<"mobile" | "desktop">("mobile");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("elettro-bio-draft:" + brand);
      setPage(stored ? JSON.parse(stored) as BioPage : defaultPage(brand));
    } catch { setPage(defaultPage(brand)); }
    setSaved(true); setMessage("");
  }, [brand]);
  const change = (next: BioPage) => { setPage(next); setSaved(false); setMessage(""); };
  const save = () => {
    try {
      window.localStorage.setItem("elettro-bio-draft:" + brand, JSON.stringify(page));
      setSaved(true); setMessage("Draft saved in this browser. No public page or DNS was changed.");
    } catch { setMessage("Browser storage is unavailable. Draft was not saved."); }
  };
  const editLink = (id: string, key: keyof BioLink, value: string | boolean) =>
    change({ ...page, links: page.links.map(l => l.id===id ? {...l, [key]:value} : l) });
  const reorder = (index: number, delta: number) => {
    const next = [...page.links]; const destination = index + delta;
    if (destination<0 || destination>=next.length) return;
    [next[index],next[destination]]=[next[destination],next[index]];
    change({...page,links:next});
  };
  const configuredHosts = Object.entries(LINK_HOSTS).filter(([, config]) => config.brand === brand && config.bio).map(([host]) => host);
  const hostname = configuredHosts[0] ?? suggestions[brand] ?? "go." + brand.replace(/[^a-z0-9-]/g,"") + ".example.com";
  const isConfigured = configuredHosts.length > 0;
  return <div className="bio-shell">\n    <main className="bio-main">
      <header className="bio-topbar">
        <div><span className="bio-eyebrow">BRAND EXPERIENCE</span><h1>Link In Bio</h1><p>Build the page first. Connect a custom domain later.</p></div>
        <div className="bio-top-actions">
          <select aria-label="Brand" value={brand} onChange={e=>setBrand(e.target.value)}>{allowedBrands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <button className="bio-primary" onClick={save}>Save draft</button>
        </div>
      </header>
      <div className="bio-banner"><strong>Review mode</strong> · Editor preview only. Drafts persist in this browser, not in the shared Elettro OS database. Edits here do not modify existing live links, DNS, or publishing. {saved ? "All edits saved." : "Unsaved changes."}</div>
      {message && <p className="bio-message" role="status">{message}</p>}
      <div className="bio-tabs"><button className={tab==="editor"?"active":""} onClick={()=>setTab("editor")}>Page editor</button><button className={tab==="dns"?"active":""} onClick={()=>setTab("dns")}>Domain & DNS setup</button></div>
      {tab==="editor" ? <div className="bio-layout">
        <section className="bio-panel">
          <div className="bio-panel-heading"><h2>Page details</h2><span>Draft</span></div>
          <label>Display name<input value={page.heading} maxLength={70} onChange={e=>change({...page,heading:e.target.value})}/></label>
          <label>Description<input value={page.description} maxLength={160} onChange={e=>change({...page,description:e.target.value})}/></label>
          <label>Accent color<input type="color" value={page.accent} onChange={e=>change({...page,accent:e.target.value})}/></label>
          <div className="bio-panel-heading"><h2>Links</h2><span>{page.links.length} total</span></div>
          {page.links.map((l,i)=><div className="bio-link-entry" key={l.id}>
            <div className="bio-link-toolbar"><strong>Link {i+1}</strong><div>
              <button aria-label={"Move "+l.title+" up"} disabled={i===0} onClick={()=>reorder(i,-1)}>↑</button>
              <button aria-label={"Move "+l.title+" down"} disabled={i===page.links.length-1} onClick={()=>reorder(i,1)}>↓</button>
              <button onClick={()=>change({...page,links:page.links.filter(x=>x.id!==l.id)})}>Remove</button>
            </div></div>
            <label>Title<input value={l.title} onChange={e=>editLink(l.id,"title",e.target.value)}/></label>
            <label>Destination URL<input type="url" value={l.url} onChange={e=>editLink(l.id,"url",e.target.value)}/></label>
            {l.url && !validUrl(l.url) && <small className="bio-error">Enter a full http:// or https:// URL.</small>}
            <label className="bio-toggle"><input type="checkbox" checked={l.enabled} onChange={e=>editLink(l.id,"enabled",e.target.checked)}/> Visible on page</label>
          </div>)}
          <button className="bio-outline" onClick={()=>change({...page,links:[...page.links,{id:"link-"+Date.now(),title:"New link",url:"https://",enabled:false}]})}>+ Add a link</button>
        </section>
        <section className="bio-preview-col">
          <div className="bio-preview-head"><h2>Page preview</h2><div><button className={view==="mobile"?"selected":""} onClick={()=>setView("mobile")}>Mobile</button><button className={view==="desktop"?"selected":""} onClick={()=>setView("desktop")}>Desktop</button></div></div>
          <div className={"bio-preview "+view}>
            <div className="bio-avatar" style={{borderColor:page.accent}}>{page.heading.slice(0,2).toUpperCase()}</div>
            <h2>{page.heading}</h2><p>{page.description}</p>
            <div className="bio-preview-links">{page.links.filter(l=>l.enabled).map(l=><div className="bio-preview-link" style={{borderColor:page.accent}} key={l.id}>{l.title}{validUrl(l.url) ? <span>↗</span> : <span>!</span>}</div>)}</div>
            <small>Powered by Elettro OS</small>
          </div>
          <p className="bio-caption">Preview controls show how the page looks. Links are intentionally inactive until publishing is implemented.</p>
        </section>
      </div> : <div className="bio-dns-grid">
        <section className="bio-panel">
          <h2>Custom domain</h2><p className="bio-status">{isConfigured ? "Configured in Elettro OS" : "Not configured in Elettro OS"}</p>
          <p>{isConfigured ? "Existing public domain" : "Suggested branded address"}</p><div className="bio-domain">{hostname}</div>
          {isConfigured && <><p><a href={"https://" + hostname + "/bio"} target="_blank" rel="noreferrer">Open existing Link In Bio page</a></p>{configuredHosts.length > 1 && <p>Additional configured hosts: {configuredHosts.slice(1).join(", ")}</p>}</>}
          {isConfigured && <p className="bio-caption">Host and bio routing are confirmed in the application configuration. DNS propagation, HTTPS certificate health and live reachability have not been independently verified by this editor.</p>}
          {!isConfigured && !suggestions[brand] && <p className="bio-error">Example placeholder only. Confirm your brand domain before using this hostname.</p>}
          <h3>{isConfigured ? "Existing domain details" : "DNS record to create later"}</h3>
          <table><tbody><tr><th>Type</th><td>CNAME</td></tr><tr><th>Name / host</th><td>go</td></tr><tr><th>Points to / value</th><td>{isConfigured ? "Existing AWS Amplify mapping (exact DNS target not retrieved)" : "Pending hosting configuration"}</td></tr><tr><th>TTL</th><td>Provider default</td></tr></tbody></table>
          <p className="bio-caption">{isConfigured ? "Do not change the existing DNS record. This editor does not manage DNS." : "Do not add a DNS record until the exact hosting destination is provided and verified."}</p>
        </section>
        <section className="bio-panel"><h2>{isConfigured ? "Existing setup and next steps" : "Activation checklist"}</h2>{isConfigured ? <p>The domain is already configured in Elettro OS. Preserve its routing. Editing a draft here will not update the live page.</p> : <ol><li>Build and save the page as a draft.</li><li>Confirm the brand's desired go subdomain.</li><li>Configure the public page hosting and get its verified CNAME destination.</li><li>Add the CNAME at your domain DNS provider.</li><li>Verify DNS, connect the host, and confirm HTTPS/SSL.</li><li>Publish the page after a final review.</li></ol>}<h3>Domain status</h3><p>Application host mapping: {isConfigured ? "Configured" : "Not configured"}</p><p>DNS: Not independently verified</p><p>SSL: Not independently verified</p><p>Link in Bio route: {isConfigured ? "Configured" : "Not configured"}</p><p className="bio-caption">Live health checks and editor publishing are not implemented. These are not live DNS or certificate test results.</p></section>
      </div>}
    </main>
  </div>;
}
