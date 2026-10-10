"use client";
import {useEffect,useState} from "react";
type Folder={id?:string;name:string;path:string};
type Listing={root:string;path:string;folders:Folder[];error?:string;details?:string};
export function DropboxFolderBrowser({brand}:{brand:string}){
 const [open,setOpen]=useState(false);
 const [path,setPath]=useState<string|null>(null);
 const [root,setRoot]=useState("");
 const [folders,setFolders]=useState<Folder[]>([]);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 async function load(target?:string){
  setLoading(true);setError("");
  try {
   const url="/api/dropbox/folders?brand="+encodeURIComponent(brand)+(target?"&path="+encodeURIComponent(target):"");
   const res=await fetch(url,{cache:"no-store"});const data:Listing=await res.json();
   if(!res.ok)throw Error(data.details?data.error+": "+data.details:data.error||"Folder listing failed");
   setRoot(data.root);setPath(data.path);setFolders(data.folders);
  }catch(e){setError(e instanceof Error?e.message:"Folder lookup failed");}
  finally{setLoading(false);}
 }
 useEffect(()=>{setPath(null);setFolders([]);setRoot("");setError("");setOpen(false);},[brand]);
 const atRoot=!path||path.toLowerCase()===root.toLowerCase();
 const parent=path&&root&&path.length>root.length?path.slice(0,path.lastIndexOf("/")):root;
 return <section className="card" style={{marginTop:14}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
   <div><div className="eyebrow">Dropbox destination · Step 1</div><h3 style={{margin:"6px 0"}}>Browse real brand folders</h3><p className="muted" style={{margin:0}}>Read-only test. Browsing does not change your files or alter the current S3 Save Raw destination.</p></div>
   <button type="button" onClick={()=>{if(!open){setOpen(true);void load();}else setOpen(false);}}>{open?"Close browser":"Browse Dropbox"}</button>
  </div>
  {open&&<div style={{marginTop:12,padding:12,background:"var(--panel-soft)",borderRadius:10}}>
   <div style={{overflowWrap:"anywhere",fontSize:12,marginBottom:12}}>Current folder: <strong>{path||"Loading..."}</strong></div>
   <div style={{display:"flex",gap:8,marginBottom:12}}>
    <button type="button" disabled={loading||atRoot} onClick={()=>void load(parent)}>← Up</button>
    <button type="button" disabled={loading} onClick={()=>void load(path||undefined)}>Refresh</button>
   </div>
   {loading&&<p role="status">Loading folders from Dropbox…</p>}
   {error&&<p role="alert" style={{color:"#b42318"}}>{error}</p>}
   {!loading&&!error&&folders.length===0&&<p className="muted">No subfolders at this level.</p>}
   {!loading&&!error&&<div style={{display:"grid",gap:6}}>
    {folders.map(folder=><button type="button" key={folder.id||folder.path} onClick={()=>void load(folder.path)} style={{textAlign:"left",padding:"10px 12px",border:"1px solid var(--line)",background:"white",borderRadius:8,cursor:"pointer"}}>📁 {folder.name}</button>)}
   </div>}
  </div>}
 </section>;
}
