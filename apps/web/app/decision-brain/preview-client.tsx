"use client";
import { useEffect, useMemo, useState } from "react";
import { getAssets, type ApiAsset } from "@/lib/dev-api";

const platforms = ["Instagram","Facebook","TikTok","YouTube","Threads","X"] as const;
type Platform = typeof platforms[number];
const initialLimits:Record<Platform,number>={Instagram:2,Facebook:2,TikTok:2,YouTube:1,Threads:3,X:3};
type Candidate={asset:ApiAsset;platform:Platform;day:number;score:number;reason:string;campaign:boolean};
function eligible(asset:ApiAsset) {
  if(asset.brandSlug!=="stashbox") return false;
  if(asset.ingestStatus?.toLowerCase()!=="ready") return false;
  if(asset.approvalStatus?.toLowerCase()!=="approved") return false;
  if(asset.eligibleFrom && new Date(asset.eligibleFrom).getTime()>Date.now()+7*86400000) return false;
  if(asset.eligibleUntil && new Date(asset.eligibleUntil).getTime()<Date.now()) return false;
  return true;
}
function worksOn(asset:ApiAsset,platform:Platform) {
  const enabled=asset.allowedDestinations||[];
  if(enabled.length && !enabled.some(x=>x.toLowerCase()===platform.toLowerCase())) return false;
  const isVideo=asset.kind?.toLowerCase().includes("video")||/\.(mp4|mov|webm)$/i.test(asset.filename);
  if(platform==="TikTok" && !isVideo) return false;
  if(platform==="YouTube" && !isVideo) return false;
  return true;
}
function scoreAsset(asset:ApiAsset,focus:string,platform:Platform,used:Set<string>) {
  const text=[asset.filename,asset.title,asset.topic,asset.contentGroup,asset.creativeFamily,asset.aiDescription,...(asset.tags||[])].filter(Boolean).join(" ").toLowerCase();
  const campaign=!!focus.trim()&&text.includes(focus.trim().toLowerCase());
  const key=asset.id+":"+platform;
  const isVideo=asset.kind?.toLowerCase().includes("video")||/\.(mp4|mov|webm)$/i.test(asset.filename);
  const fit=(platform==="Instagram"||platform==="TikTok")? asset.aspectRatioLabel==="9:16":platform==="YouTube"?isVideo:true;
  const priority=asset.priority==="high"?15:asset.priority==="low"?-8:0;
  const freshness=asset.lastUsedAt?0:12;
  return {score:40+(campaign?30:0)+(fit?12:0)+priority+freshness-(used.has(key)?100:0),campaign,reason:[campaign?"Matches campaign focus":"Evergreen variety",fit?"platform-format match":"format may need adaptation",!asset.lastUsedAt?"not previously used":"previously used"].join(" · ")};
}
export function DecisionPreview(){
  const [assets,setAssets]=useState<ApiAsset[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [limits,setLimits]=useState<Record<Platform,number>>(initialLimits);
  const [focus,setFocus]=useState("Dylan");
  const [days,setDays]=useState(7);
  const [enabled,setEnabled]=useState<Platform[]>(["Instagram","Facebook","TikTok","YouTube","Threads","X"]);
  useEffect(()=>{getAssets().then(x=>setAssets(x.assets||[])).catch(e=>setError(e instanceof Error?e.message:"Unable to load assets")).finally(()=>setLoading(false));},[]);
  const ready=useMemo(()=>assets.filter(eligible),[assets]);
  const schedule=useMemo(()=>{
    const generated:Candidate[]=[];
    const used=new Set<string>();
    const counts=new Map<string,number>();
    let campaignCount=0;
    for(let day=0;day<days;day++){
      for(const platform of enabled){
        const limit=limits[platform]||0;
        // Adaptive baseline is one recommendation on eligible days, never a forced quota.
        const recommendationCount=Math.min(limit,1);
        for(let n=0;n<recommendationCount;n++){
          const pool=ready.filter(a=>worksOn(a,platform)&&!used.has(a.id+":"+platform));
          if(!pool.length)continue;
          const targetCampaign=(campaignCount/(generated.length||1))<0.6;
          const sorted=pool.map(asset=>({asset,...scoreAsset(asset,focus,platform,used)})).sort((a,b)=>((b.campaign===targetCampaign?16:0)+b.score)-((a.campaign===targetCampaign?16:0)+a.score));
          const picked=sorted[0];
          used.add(picked.asset.id+":"+platform);
          campaignCount+=Number(picked.campaign);
          generated.push({asset:picked.asset,platform,day,score:picked.score,reason:picked.reason,campaign:picked.campaign});
          counts.set(platform,(counts.get(platform)||0)+1);
        }
      }
    }
    return generated;
  },[ready,focus,limits,enabled,days]);
  const byDay=Array.from({length:days},(_,day)=>schedule.filter(s=>s.day===day));
  return <div className="grid" style={{gap:18}}>
    <section className="card">
      <div className="eyebrow">Creative Director Mode · Simulation</div>
      <h2>Publishing guardrails</h2>
      <p className="muted">Set the maximum daily posts for each network. Zero disables that network. These settings affect this preview only; they are not yet saved as live publishing policy.</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:12}}>
        {platforms.map(platform=><label key={platform} style={{display:"grid",gap:6}}>
          <span style={{fontWeight:600}}>{platform}</span>
          <input type="number" min={0} max={10} value={limits[platform]} onChange={e=>setLimits(previous=>({...previous,[platform]:Math.max(0,Math.min(10,Number(e.target.value)||0))}))}/>
          <span className="muted" style={{fontSize:12}}>Max posts/day</span>
        </label>)}
      </div>
      <div style={{marginTop:15,display:"grid",gap:8,maxWidth:430}}>
        <label style={{fontWeight:600}}>Active campaign focus</label>
        <input value={focus} onChange={e=>setFocus(e.target.value)} placeholder="e.g. Dylan"/>
        <span className="muted" style={{fontSize:12}}>Default campaign mix: 60% focus / 40% variety. Default same-platform reuse cooldown: 30 days. Historical cooldown checks are not connected yet.</span>
      </div>
    </section>
    <section className="card">
      <h2>Live Stashbox asset eligibility</h2>
      {loading?<p>Loading asset library…</p>:error?<p role="alert">{error}</p>:<p><strong>{ready.length}</strong> Ready and approved assets from <strong>{assets.filter(a=>a.brandSlug==="stashbox").length}</strong> Stashbox records.</p>}
      <p className="muted">Candidates are read from Brand OS, not fabricated. Unsupported formats and network exclusions are filtered. No performance-based learning, caption generation, timezone optimization, or real posting occurs yet.</p>
    </section>
    <section className="card">
      <h2>Seven-day candidate schedule</h2>
      <p className="muted">{schedule.length} proposed placements. Each explains its eligibility and basic ranking. Suggested order is not a promised publication time.</p>
      {byDay.map((dayItems,day)=><div key={day} style={{padding:"12px 0",borderTop:"1px solid var(--line)"}}>
        <h3>Day {day+1}</h3>
        {!dayItems.length?<p className="muted">No eligible assets for these constraints.</p>:dayItems.map(item=><div key={item.platform+":"+item.asset.id} style={{padding:"8px 0",display:"grid",gap:3}}>
          <strong>{item.platform} · {item.asset.title||item.asset.filename}</strong>
          <span className="muted" style={{fontSize:12}}>{item.reason} · score {item.score} · {item.campaign?"Campaign":"Variety"}</span>
        </div>)}
      </div>)}
    </section>
  </div>;
}
