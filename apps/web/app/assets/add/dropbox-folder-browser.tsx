"use client";
import {useEffect,useState} from "react";
type Folder={id?:string;name:string;path:string};
type Listing={root:string;path:string;folders:Folder[];error?:string;details?:string};
export function DropboxFolderBrowser({brand,fileTypes=[],onSelect}:{brand:string;fileTypes?:string[];onSelect?:(path:string|null)=>void}){
 const [open,setOpen]=useState(false);
 const [selected,setSelected]=useState<string|null>(null);
 const [creating,setCreating]=useState(false);
 const [newFolderName,setNewFolderName]=useState("");
 const [savingFolder,setSavingFolder]=useState(false);
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
 useEffect(()=>{setPath(null);setFolders([]);setRoot("");setError("");setOpen(false);setSelected(null);onSelect?.(null);},[brand]);
 const onlyImages=fileTypes.length>0&&fileTypes.every(type=>type.startsWith("image/"));
 const onlyVideos=fileTypes.length>0&&fileTypes.every(type=>type.startsWith("video/"));
 const suggested=folders.find(folder=>onlyImages?/^images?$/i.test(folder.name):onlyVideos?/^videos?$/i.test(folder.name):false);
 function choose(folderPath:string){setSelected(folderPath);onSelect?.(folderPath);}
 async function createFolder(){
  if(!path||!newFolderName.trim()||savingFolder)return;
  setSavingFolder(true);setError("");
  try{
   const response=await fetch("/api/dropbox/folders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({brand,path,name:newFolderName.trim()})});
   const payload=await response.json();
   if(!response.ok||payload.ok===false)throw new Error(payload.detail?`${payload.error}: ${payload.detail}`:payload.error||"Folder creation failed");
   setNewFolderName("");setCreating(false);
   await load(path);
   if(payload.path)choose(payload.path);
  }catch(error){setError(error instanceof Error?error.message:"Folder creation failed");}
  finally{setSavingFolder(false);}
 }
 const atRoot=!path||path.toLowerCase()===root.toLowerCase();
 const parent=path&&root&&path.length>root.length?path.slice(0,path.lastIndexOf("/")):root;
 return <section className="card" style={{marginTop:14}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
   <div><div className="eyebrow">Dropbox destination · Step 1</div><h3 style={{margin:"6px 0"}}>Browse real brand folders</h3><p className="muted" style={{margin:0}}>Read-only test. Browsing does not change your files or alter the current S3 Save Raw destination.</p></div>
   <button type="button" onClick={()=>{if(!open){setOpen(true);void load();}else setOpen(false);}}>{open?"Close browser":"Browse Dropbox"}</button>
  </div>
  <div style={{marginTop:12,padding:12,fontSize:13,border:"1px solid var(--line)",borderRadius:8,background:"var(--panel-soft)"}}>
   <strong>Planned Dropbox destination:</strong> <span style={{overflowWrap:"anywhere"}}>{selected||"Not selected yet"}</span>
   <p className="muted" style={{margin:"6px 0 0"}}>Selection is a preview only. Save Raw and Ingest & Ready still use current Brand OS/S3 storage; no file is written to Dropbox.</p>
   {selected&&<button type="button" onClick={()=>{setSelected(null);onSelect?.(null);}} style={{marginTop:8}}>Clear selection</button>}
  </div>
  {open&&<div style={{marginTop:12,padding:12,background:"var(--panel-soft)",borderRadius:10}}>
   <div style={{overflowWrap:"anywhere",fontSize:12,marginBottom:12}}>Current folder: <strong>{path||"Loading..."}</strong></div>
   <div style={{display:"flex",gap:8,marginBottom:12}}>
    <button type="button" disabled={loading||atRoot} onClick={()=>void load(parent)}>← Up</button>
    <button type="button" disabled={loading} onClick={()=>void load(path||undefined)}>Refresh</button>
    <button type="button" disabled={loading||!path||savingFolder} onClick={()=>setCreating(value=>!value)}>+ New folder</button>
   </div>
   {creating&&<div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}><input aria-label="New folder name" value={newFolderName} onChange={event=>setNewFolderName(event.target.value)} placeholder="e.g. 16x9" maxLength={180}/><button type="button" disabled={savingFolder||!newFolderName.trim()} onClick={()=>void createFolder()}>{savingFolder?"Creating…":"Create in Dropbox"}</button><button type="button" onClick={()=>setCreating(false)}>Cancel</button></div>}
   {loading&&<p role="status">Loading folders from Dropbox…</p>}
   {!loading&&!error&&path&&<button type="button" onClick={()=>choose(path)} style={{marginBottom:12,border:"1px solid var(--line)",background:"white",padding:"8px 12px",borderRadius:8}}>Use this folder as planned destination</button>}
   {!loading&&!error&&suggested&&<p style={{fontSize:12,margin:"0 0 12px"}}>Suggested for this batch: <strong>{suggested.name}</strong> (based on file type, not AI content analysis). <button type="button" onClick={()=>choose(suggested.path)}>Select suggestion</button></p>}
   {error&&<p role="alert" style={{color:"#b42318"}}>{error}</p>}
   {!loading&&!error&&folders.length===0&&<p className="muted">No subfolders at this level.</p>}
   {!loading&&!error&&<div style={{display:"grid",gap:6}}>
    {folders.map(folder=><div key={folder.id||folder.path} style={{display:"flex",alignItems:"center",gap:8}}><button type="button" onClick={()=>void load(folder.path)} style={{flex:1,textAlign:"left",padding:"10px 12px",border:"1px solid var(--line)",background:"white",borderRadius:8,cursor:"pointer"}}>📁 {folder.name} →</button><button type="button" onClick={()=>choose(folder.path)} style={{padding:"10px 12px",border:"1px solid var(--line)",borderRadius:8,background:selected===folder.path?"#e9f8ef":"white",cursor:"pointer"}}>{selected===folder.path?"Selected":"Select"}</button></div>)}
   </div>}
  </div>}
 </section>;
}
