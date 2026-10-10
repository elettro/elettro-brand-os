"use client";
import {useMemo,useState} from "react";
import Link from "next/link";
import {recommendFolder,applyDropboxChange,brandRoot,type AssetSignal,type FolderObservation} from "@/lib/folder-learning";
const initial:AssetSignal={brand:"stashbox",campaign:"stashbox-does-dylan",purpose:"finished-video",shape:"9x16"};
const options=["source-images","social-graphics","source-footage","finished-video"];
const shapes=["9x16","16x9","1x1","4x5"];
export default function FolderLearningLab(){
 const [signal,setSignal]=useState<AssetSignal>(initial);
 const [history,setHistory]=useState<FolderObservation[]>([]);
 const [seq,setSeq]=useState(0);
 const [folder,setFolder]=useState("video/stashbox-does-dylan/finished-video/9x16/");
 const suggestion=useMemo(()=>recommendFolder(signal,history),[signal,history]);
 const full=(value:string)=>brandRoot(signal.brand)+value.replace(/^\/+|\/+$/g,"")+"/";
 const observe=(type:FolderObservation["event"],fileId:string,path:string)=>{setHistory(h=>applyDropboxChange(h,{fileId,signal:{...signal},path,event:type,at:Date.now()+h.length}));};
 const addExamples=(amount:number)=>{const start=seq;const target=full(folder);setHistory(h=>{let next=h;for(let i=0;i<amount;i++)next=applyDropboxChange(next,{fileId:"demo-"+(start+i),signal:{...signal},path:target,event:"manual_choice",at:Date.now()+i+h.length});return next;});setSeq(n=>n+amount);};
 const current=history.filter(h=>h.signal.brand===signal.brand&&h.signal.campaign===signal.campaign&&h.signal.purpose===signal.purpose&&h.signal.shape===signal.shape&&h.event!=="batch_override");
 const latest=new Map<string,FolderObservation>();current.forEach(x=>latest.set(x.fileId,x));
 const sample=Array.from(latest.values());
 const relocate=()=>{if(sample.length===0)return;const item=sample[0];observe("file_moved",item.fileId,full(folder));};
 const reset=()=>{setHistory([]);setSeq(0);};
 return <main className="main" style={{maxWidth:1100,margin:"auto"}}>
  <Link href="/assets/add" style={{color:"#e8590c"}}>← Smart Batch Intake</Link>
  <div className="eyebrow" style={{marginTop:16}}>Interactive simulation · no Dropbox write access</div><h1>Folder Learning Lab</h1>
  <p className="muted">Teach the recommender with simulated file choices. It follows a Dropbox file ID across moves. Reloading the page resets the simulation.</p>
  <div className="card" style={{marginTop:18,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
   <label>Brand<br/><select value={signal.brand} className="brand-select" onChange={e=>setSignal(s=>({...s,brand:e.target.value}))}>{["stashbox","solarmeister","elettro","neckermann-strom"].map(v=><option key={v}>{v}</option>)}</select></label>
   <label>Campaign<br/><input value={signal.campaign} onChange={e=>setSignal(s=>({...s,campaign:e.target.value}))} style={{padding:10,width:"100%"}}/></label>
   <label>Purpose<br/><select value={signal.purpose} onChange={e=>setSignal(s=>({...s,purpose:e.target.value}))} className="brand-select">{options.map(v=><option key={v}>{v}</option>)}</select></label>
   <label>Shape<br/><select value={signal.shape} onChange={e=>setSignal(s=>({...s,shape:e.target.value}))} className="brand-select">{shapes.map(v=><option key={v}>{v}</option>)}</select></label>
  </div>
  <section className="card" style={{marginTop:14}}>
   <h2>Suggested folder</h2><strong style={{color:suggestion.confidence>=75&&suggestion.sampleSize>=5?"#027a48":"#b54708"}}>{suggestion.path||"No confident recommendation"}</strong>
   <p className="muted">{suggestion.confidence}% evidence score · {suggestion.sampleSize} unique comparable assets</p>
   <p>{suggestion.reason}</p>
  </section>
  <section className="card" style={{marginTop:14}}>
   <h2>Train the example</h2><p className="muted">Destination relative to the simulated brand root: {brandRoot(signal.brand)}</p>
   <input aria-label="Destination subfolder" value={folder} onChange={e=>setFolder(e.target.value)} style={{width:"100%",padding:11,marginBottom:12}}/>
   <div style={{display:"flex",flexWrap:"wrap",gap:9}}>
    <button onClick={()=>addExamples(1)}>Place 1 asset here</button>
    <button onClick={()=>addExamples(5)}>Place 5 matching assets</button>
    <button onClick={relocate} disabled={!sample.length}>Move first matching file here</button>
    <button onClick={()=>observe("batch_override","batch-"+seq,full(folder))}>Simulate one-time batch override</button>
    <button onClick={reset}>Reset simulation</button>
   </div>
   <p className="muted" style={{marginTop:10}}>Moving the same file updates its latest destination. One-time batch overrides do not train the model.</p>
  </section>
  <section className="card" style={{marginTop:14}}>
   <h2>Recorded activity</h2>
   <p className="muted">{history.length} events · {sample.length} matching unique assets for the current group</p>
   <div style={{maxHeight:240,overflow:"auto"}}>{[...history].reverse().slice(0,30).map((h,i)=><div key={i} style={{padding:9,borderBottom:"1px solid #ddd",fontSize:12}}><b>{h.event}</b> · {h.fileId}<div style={{overflowWrap:"anywhere"}}>{h.path}</div></div>)}</div>
  </section>
  <p className="muted" style={{marginTop:16}}>This lab tests recommendation logic only. Dropbox folder browsing, server-side learning persistence, uploads and delta synchronization remain to be connected.</p>
 </main>;
}
