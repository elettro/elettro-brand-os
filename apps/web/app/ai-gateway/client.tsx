"use client";
import {useState} from "react";
const brands=[
 {id:"stashbox",name:"Stashbox"},
 {id:"elettro",name:"Elettro"},
 {id:"solarmeister",name:"SolarMeister"},
 {id:"weightlossdavie",name:"WeightLossDavie"},
 {id:"neckermann-strom",name:"Neckermann Strom"},
 {id:"therasbox",name:"Therasbox"}
];

export function AiGatewayLabClient(){
 const [brand,setBrand]=useState("stashbox");
 const [query,setQuery]=useState("");
 const [busy,setBusy]=useState(false);
 const [current,setCurrent]=useState("");
 const [error,setError]=useState("");
 const [reply,setReply]=useState<unknown>(null);
 async function call(action:"capabilities"|"search_assets"|"list_folders"){
  setBusy(true);setError("");setCurrent(action);setReply(null);
  try{
   const args=action==="search_assets"?{action,brandSlug:brand,query,limit:10}:
    action==="list_folders"?{action,scope:"brand",brandSlug:brand}:{action};
   const res=await fetch("/api/ai-gateway",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(args)
   });
   const result=await res.json();
   if(!res.ok||result.ok===false)throw new Error(result.error||"Gateway request failed");
   setReply(result);
  }catch(e){setError(e instanceof Error?e.message:"Gateway unavailable");}
  finally{setBusy(false);}
 }
 return <section className="card" style={{marginTop:18}}>
  <h2 style={{marginTop:0}}>Read-only smoke tests</h2>
  <p className="muted">These buttons only inspect the gateway. They cannot create, move, delete, register or publish anything.</p>
  <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"end"}}>
   <label style={{display:"grid",gap:5}}>
    <span className="metric">Brand</span>
    <select value={brand} onChange={event=>setBrand(event.target.value)} disabled={busy}>
     {brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
   </label>
   <label style={{display:"grid",gap:5}}>
    <span className="metric">Asset search</span>
    <input value={query} maxLength={160} onChange={event=>setQuery(event.target.value)} placeholder="Title, tags, filename..." disabled={busy}/>
   </label>
  </div>
  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:14}}>
   <button type="button" disabled={busy} onClick={()=>void call("capabilities")}>Check API</button>
   <button type="button" disabled={busy} onClick={()=>void call("search_assets")}>Search brand assets</button>
   <button type="button" disabled={busy} onClick={()=>void call("list_folders")}>Browse brand root</button>
  </div>
  {busy&&<p role="status" className="muted">Checking {current.replaceAll("_"," ")}…</p>}
  {error&&<p role="alert" style={{color:"#b42318"}}>{error}</p>}
  {reply!==null&&<div style={{marginTop:16}}>
   <strong>{current.replaceAll("_"," ")} succeeded</strong>
   <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",overflow:"auto",maxHeight:400,marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
    {JSON.stringify(reply,null,2)}
   </pre>
  </div>}
  <p className="muted" style={{marginTop:18,fontSize:12}}>The external ChatGPT and Claude connector setup remains separate. This page does not configure assistant credentials.</p>
 </section>;
}
