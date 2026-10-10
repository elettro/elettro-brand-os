"use client";
import {useState} from "react";
import Link from "next/link";
import {brandConfigs} from "@/lib/brand-config";
import {destinationsForBrand} from "@/lib/brand-destinations";
export default function BrandDestinationsPage(){
 const [brand,setBrand]=useState<string>(brandConfigs[0].id);
 const destinations=destinationsForBrand(brand);
 return <main className="main" style={{maxWidth:1150,margin:"auto"}}>
 <Link href="/assets">← Asset Library</Link><div className="eyebrow" style={{marginTop:20}}>Publishing / Configuration preview</div>
 <h1>Brand Destinations</h1>
 <p className="muted">Each brand owns its destinations. Social accounts, websites, CMS targets and RSS feeds remain separate. This preview does not connect accounts or publish content.</p>
 <section className="card" style={{marginTop:18}}><label>Brand workspace<br/><select className="brand-select" value={brand} onChange={e=>setBrand(e.target.value)}>{brandConfigs.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label></section>
 <section className="card" style={{marginTop:14,overflowX:"auto"}}>
 <table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>{["Destination","Channel","Publishing mode","Connection"].map(v=><th key={v} style={{textAlign:"left",padding:12,borderBottom:"1px solid #ddd"}}>{v}</th>)}</tr></thead><tbody>
 {destinations.map(d=><tr key={d.id}><td style={{padding:12,borderBottom:"1px solid #eee"}}>{d.label}</td><td style={{padding:12,borderBottom:"1px solid #eee"}}>{d.channel}</td><td style={{padding:12,borderBottom:"1px solid #eee"}}>{d.publishingMode}</td><td style={{padding:12,borderBottom:"1px solid #eee",color:"#b54708"}}>{d.connectionStatus}</td></tr>)}
 </tbody></table></section><p className="muted">Next: persist this registry per brand, support multiple targets of the same channel, verify destination URLs, and connect individual publishing APIs. RSS feed consumption and RSS feed production require separate configurations.</p>
 </main>;
}