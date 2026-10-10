"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";

type Purpose = "source-images" | "social-graphics" | "source-footage" | "finished-video" | "other";
type Item = { id:string; file:File; name:string; purpose:Purpose; shape:string; width?:number; height?:number; duration?:number; campaign:string; status:"Analyzing"|"Suggestions Ready"; folder:string; decision:"suggested"|"manual"|"none"; confidence:number };
const LABELS:Record<Purpose,string> = {"source-images":"Source images","social-graphics":"Social graphics","source-footage":"Source footage","finished-video":"Finished video",other:"Other files"};
const slug=(v:string)=>v.toLowerCase().replace(/\.[^.]+$/,"").replace(/(?:[_\s-]+(?:final|v\d+|clip|take|render|export|edit|source|raw|vertical|horizontal|portrait|landscape|\d+))+$/gi,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const ratio=(w:number,h:number)=>{if(!w||!h)return "Unknown";const r=w/h; if(Math.abs(r-9/16)<.06)return "9x16";if(Math.abs(r-16/9)<.09)return "16x9";if(Math.abs(r-1)<.08)return "1x1";if(Math.abs(r-4/5)<.07)return "4x5";return w>h?"Landscape": "Portrait";};
function infer(file:File):Purpose {const n=file.name.toLowerCase();if(file.type.startsWith("video/"))return /raw|broll|b-roll|camera|take|source|footage/.test(n)?"source-footage":"finished-video";if(file.type.startsWith("image/"))return /source|raw|reference|original|input/.test(n)?"source-images":"social-graphics";return "other";}
function readMedia(file:File):Promise<{width?:number;height?:number;duration?:number}> {
 return new Promise(resolve=>{if(!file.type.startsWith("image/")&&!file.type.startsWith("video/"))return resolve({});
 const url=URL.createObjectURL(file);const clean=(v:{width?:number;height?:number;duration?:number})=>{URL.revokeObjectURL(url);resolve(v)};
 if(file.type.startsWith("image/")){const img=new Image();img.onload=()=>clean({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>clean({});img.src=url;}
 else {const video=document.createElement("video");video.preload="metadata";video.onloadedmetadata=()=>clean({width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)?video.duration:undefined});video.onerror=()=>clean({});video.src=url;}
 });
}
const suggestedPath=(brand:string,campaign:string,purpose:Purpose,shape:string)=>`/${brand}/${purpose.includes("video")||purpose==="source-footage"?"video":"images"}/${campaign||"uncategorized"}/${purpose}/${shape==="Unknown"?"unsorted":shape.toLowerCase()}/`;
const groupKey=(x:Item)=>[x.campaign,x.purpose,x.shape].join("|");
export default function SmartIntakePage(){
 const [brand,setBrand]=useState("stashbox");const [campaign,setCampaign]=useState("");const [items,setItems]=useState<Item[]>([]);
 const [auto,setAuto]=useState(true);const [filter,setFilter]=useState("all");const [edit,setEdit]=useState<string|null>(null);const [path,setPath]=useState("");
 const input=useRef<HTMLInputElement>(null);const [message,setMessage]=useState("");
 const add=async(files:FileList|null)=>{if(!files?.length)return;setMessage("");const batch=Array.from(files);const ids=batch.map((_,i)=>`${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`);
 const created:Item[]=batch.map((file,i)=>({id:ids[i],file,name:file.name,purpose:infer(file),shape:"Unknown",campaign:slug(campaign)||"uncategorized",status:"Analyzing",folder:"",decision:"none",confidence:0}));
 setItems(old=>[...old,...created]);
 await Promise.all(created.map(async x=>{const m=await readMedia(x.file);const shape=ratio(m.width||0,m.height||0);const confident=x.campaign!=="uncategorized"&&shape!=="Unknown";
 const dest=confident?suggestedPath(brand,x.campaign,x.purpose,shape):"";
 setItems(old=>old.map(row=>row.id===x.id?{...row,...m,shape,status:"Suggestions Ready",folder:auto?dest:"",decision:auto&&confident?"suggested":"none",confidence:confident?80:0}:row));}));
 };
 const groups=useMemo(()=>{const map=new Map<string,Item[]>();items.forEach(x=>{const key=groupKey(x);map.set(key,[...(map.get(key)||[]),x]);});return Array.from(map.entries()).map(([key,members])=>({key,members,first:members[0]}));},[items]);
 const chosen=items.filter(x=>!!x.folder).length;const unresolved=items.filter(x=>!x.folder&&x.status!=="Analyzing").length;
 const apply=(ids:string[],dest:string,decision:Item["decision"]="manual")=>{const clean=dest.trim();if(!clean.startsWith("/")||clean.includes("..")){setMessage("Enter a Dropbox-style absolute folder path starting with /.");return;}setItems(old=>old.map(x=>ids.includes(x.id)?{...x,folder:clean.endsWith("/")?clean:clean+"/",decision,confidence:decision==="manual"?100:x.confidence}:x));setEdit(null);setMessage(`Destination assigned to ${ids.length} file(s). Nothing has been uploaded.`);};
 const reset=()=>setItems(old=>old.map(x=>x.decision==="manual"?x:{...x,folder:auto&&x.confidence>=80?suggestedPath(brand,x.campaign,x.purpose,x.shape):"",decision:auto&&x.confidence>=80?"suggested":"none"}));
 const setPurpose=(id:string,purpose:Purpose)=>setItems(old=>old.map(x=>x.id!==id?x:{...x,purpose,folder:"",decision:"none",confidence:0}));
 const view=groups.filter(g=>filter==="all"||(filter==="needs"&&g.members.some(x=>!x.folder))||(filter==="ready"&&g.members.every(x=>!!x.folder)));
 return <main className="main" style={{maxWidth:1250,margin:"auto"}}>
  <Link href="/assets" style={{color:"#e8590c"}}>← Asset Library</Link> <span style={{margin:"0 12px"}}>·</span> <Link href="/assets/folder-learning-lab" style={{color:"#e8590c"}}>Test Folder Learning →</Link>
  <div className="eyebrow" style={{marginTop:18}}>Add Assets / Prototype</div><h1>Smart Batch Intake</h1>
  <p className="muted">Dropbox is the planned source of truth. This prototype analyzes local files and previews folder decisions. It does not access or upload to Dropbox.</p>
  <section className="card" style={{marginTop:18,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12}}>
   <label>Brand<br/><select className="brand-select" value={brand} onChange={e=>setBrand(e.target.value)}>{["stashbox","solarmeister","elettro","neckermann-strom","bluecard"].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
   <label>Campaign / collection<br/><input value={campaign} onChange={e=>setCampaign(e.target.value)} placeholder="stashbox-does-dylan" style={{padding:11,border:"1px solid #ddd",borderRadius:8,width:"100%"}}/></label>
   <label style={{display:"flex",alignItems:"center",gap:8}}><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> Auto-select confident destinations</label>
  </section>
  <section className="card" style={{marginTop:14,textAlign:"center",padding:32,borderStyle:"dashed"}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void add(e.dataTransfer.files);}}>
   <input ref={input} type="file" multiple hidden onChange={e=>{void add(e.target.files);e.target.value="";}}/>
   <h2>Drop files or select a batch</h2><p className="muted">Quick analysis starts immediately. Images and video metadata are inspected in your browser.</p>
   <button onClick={()=>input.current?.click()} style={{padding:"11px 18px",background:"#e8590c",color:"white",border:0,borderRadius:9,cursor:"pointer"}}>Choose Files</button>
  </section>
  {items.length>0&&<>
   <section className="card" style={{marginTop:14,display:"flex",gap:18,flexWrap:"wrap",alignItems:"center",justifyContent:"space-between"}}>
    <div><strong>{items.length} selected · {chosen} destinations selected · {unresolved} need review</strong><p className="muted" style={{margin:"4px 0 0"}}>No files saved. Recommendations are proposals based on campaign, file type and dimensions, not historical Dropbox matches.</p></div>
    <div style={{display:"flex",gap:8}}><button onClick={reset}>Reset recommendations</button><button onClick={()=>{setItems([]);setMessage("");}}>Clear batch</button></div>
   </section>
   <div style={{display:"flex",gap:10,marginTop:16}}>{[["all","All groups"],["needs","Needs folder"],["ready","Assigned"]].map(([v,l])=><button key={v} onClick={()=>setFilter(v)} style={{borderRadius:8,padding:"8px 12px",border:"1px solid #ddd",background:filter===v?"#fff1e8":"white"}}>{l}</button>)}</div>
   {view.map(g=><section className="card" key={g.key} style={{marginTop:12}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
     <div><strong>{LABELS[g.first.purpose]} · {g.first.shape}</strong><div className="muted">{g.members.length} files · {g.first.campaign}</div></div>
     <button onClick={()=>{setEdit("group:"+g.key);setPath(g.members.find(x=>x.folder)?.folder||suggestedPath(brand,g.first.campaign,g.first.purpose,g.first.shape));}}>Choose folder for all {g.members.length}</button>
    </div>
    <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",marginTop:12,fontSize:13}}><thead><tr>{["File","Details / purpose","Status / destination","Action"].map(h=><th key={h} style={{textAlign:"left",padding:9,borderBottom:"1px solid #ddd"}}>{h}</th>)}</tr></thead><tbody>{g.members.map(x=><tr key={x.id}>
     <td style={{padding:9,borderBottom:"1px solid #eee"}}>{x.name}</td>
     <td style={{padding:9,borderBottom:"1px solid #eee"}}>{x.width&&x.height?`${x.width}×${x.height}`:"Metadata pending"}{x.duration!==undefined?` · ${Math.round(x.duration)}s`:""}<br/><select value={x.purpose} onChange={e=>setPurpose(x.id,e.target.value as Purpose)}>{Object.entries(LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></td>
     <td style={{padding:9,borderBottom:"1px solid #eee"}}><span title={x.folder||"No confident folder suggestion. Choose destination."} style={{cursor:"help",color:x.folder?"#027a48":"#b54708",fontWeight:600}}>{x.status==="Analyzing"?"Analyzing…":x.folder?(x.decision==="manual"?"Selected manually":"Suggestions Ready · Auto-selected"):"Choose Folder"}</span><div style={{fontSize:11,color:"#667085",maxWidth:360,overflowWrap:"anywhere"}}>{x.folder||"No folder assigned"}</div></td>
     <td style={{padding:9,borderBottom:"1px solid #eee"}}><button onClick={()=>{setEdit(x.id);setPath(x.folder||"");}}>Change</button> <button aria-label={"Remove "+x.name} onClick={()=>setItems(old=>old.filter(y=>y.id!==x.id))}>×</button></td>
    </tr>)}</tbody></table></div>
    {edit==="group:"+g.key&&<div style={{marginTop:12,background:"#f8fafc",padding:12,borderRadius:8}}>
     <strong>Choose Dropbox destination for {g.members.length} similar files</strong><p className="muted">Prototype path entry. Live Browse and + Add Folder require a Dropbox-backed API.</p>
     <input aria-label="Dropbox folder path" value={path} onChange={e=>setPath(e.target.value)} style={{width:"75%",padding:9}}/>
     <button onClick={()=>apply(g.members.map(x=>x.id),path)}>Apply to group</button> <button onClick={()=>setEdit(null)}>Cancel</button>
    </div>}
    {g.members.some(x=>edit===x.id)&&<div style={{marginTop:12,background:"#f8fafc",padding:12,borderRadius:8}}>
     <strong>Apply selected destination</strong><input aria-label="Destination path" value={path} onChange={e=>setPath(e.target.value)} placeholder="/stashbox/video/..." style={{width:"100%",padding:9,margin:"8px 0"}}/>
     <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button onClick={()=>apply(g.members.filter(x=>edit===x.id).map(x=>x.id),path)}>Only this file</button><button onClick={()=>apply(g.members.map(x=>x.id),path)}>All {g.members.length} similar files</button><button onClick={()=>apply(items.map(x=>x.id),path)}>Entire batch ({items.length})</button><button onClick={()=>setEdit(null)}>Cancel</button></div>
    </div>}
   </section>)}
   <section className="card" style={{marginTop:16}}><strong>Save options</strong><p className="muted">Save Raw and Ingest & Ready will be wired to Dropbox upload and indexing after the backend integration. This preview never marks files as saved.</p>
    <button disabled>Save Raw · coming with Dropbox integration</button> <button disabled>Ingest & Ready · coming with Dropbox integration</button>
   </section>
  </>}
  {message&&<p role="status" style={{color:"#b54708"}}>{message}</p>}
 </main>;
}
