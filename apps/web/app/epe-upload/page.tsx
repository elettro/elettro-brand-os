"use client";
import {useEffect,useState} from "react";
type Result=Record<string,unknown>;
async function request(body:Result):Promise<Result>{
 const response=await fetch("/api/mcp/claude-upload",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok||result.ok===false)throw new Error(result.error||result.message||"Transfer needs review");return result;
}
async function hash(file:File){
 const blocks:Uint8Array[]=[];
 for(let offset=0;offset<file.size;offset+=4*1024*1024){
  blocks.push(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.slice(offset,offset+4*1024*1024).arrayBuffer())));
 }
 const joined=new Uint8Array(blocks.length*32);blocks.forEach((block,i)=>joined.set(block,i*32));
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",joined))).map(v=>v.toString(16).padStart(2,"0")).join("");
}
function encoded(bytes:Uint8Array){
 const parts:string[]=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
 return btoa(parts.join(""));
}
export default function EpeUpload(){
 const [portalToken,setPortalToken]=useState("");const [preview,setPreview]=useState<Result>();
 const [file,setFile]=useState<File>();const [busy,setBusy]=useState(false);const [status,setStatus]=useState("Loading upload link…");
 const [transferToken,setTransferToken]=useState("");const [result,setResult]=useState<Result>();
 useEffect(()=>{
  const token=window.location.hash.slice(1);setPortalToken(token);
  if(!token){setStatus("Open the upload link supplied by Claude.");return;}
  request({action:"preview",portalToken:token}).then(value=>{setPreview(value);setStatus("Select the image or video to save.");}).catch(error=>setStatus(error.message));
 },[]);
 async function complete(token:string){
  const value=await request({action:"complete",portalToken,transferToken:token});setResult(value);setStatus("Saved to EPE. Metadata and Dropbox identity verified.");
 }
 async function upload(){
  if(!file||!preview)return;
  if(file.size<1||file.size>20*1024*1024){setStatus("Choose a file between 1 byte and 20 MiB.");return;}
  setBusy(true);setResult(undefined);
  try{
   setStatus("Checking file content…");
   const plan=await request({action:"prepare",portalToken,size:file.size,contentHash:await hash(file)});
   const token=String(plan.transferToken);setTransferToken(token);
   if(plan.uploadRequired){
    let cursorToken:unknown;
    for(let offset=0;offset<file.size;offset+=2*1024*1024){
     setStatus("Uploading to Dropbox: "+Math.floor(offset/file.size*100)+"%");
     const bytes=new Uint8Array(await file.slice(offset,offset+2*1024*1024).arrayBuffer());
     const chunk=await request({action:"chunk",portalToken,transferToken:token,chunkBase64:encoded(bytes),...(cursorToken?{cursorToken}:{})});
     cursorToken=chunk.cursorToken;
    }
   }
   setStatus("Verifying and registering in EPE…");await complete(token);
  }catch(error){setStatus(error instanceof Error?error.message:"Transfer needs review");}
  finally{setBusy(false);}
 }
 return <main style={{maxWidth:680,margin:"48px auto",padding:24,fontFamily:"sans-serif"}}>
  <h1>Save to EPE</h1>
  {preview&&<><p><strong>Filename:</strong> {String(preview.filename)}</p><p><strong>Folder:</strong> {String(preview.folder)}</p>
   <p><strong>Metadata:</strong></p><pre style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(preview.metadata,null,2)}</pre>
   <p>New assets are saved as Raw and Approved. This upload does not publish.</p>
   <label>Image or video (up to 20 MiB)<br/><input type="file" accept="image/*,video/*" disabled={busy||!!transferToken} onChange={event=>setFile(event.target.files?.[0])}/></label>
   <p><button disabled={!file||busy||!!transferToken} onClick={upload}>Save file to EPE</button></p>
  </>}
  <p role="status">{status}</p>
  {transferToken&&!result&&<><p>If a response was interrupted, check completion before starting another transfer.</p>
   <button disabled={busy} onClick={async()=>{setBusy(true);try{await complete(transferToken);}catch(error){setStatus(error instanceof Error?error.message:"Completion needs review");}finally{setBusy(false);}}}>Check completion</button></>}
  {result&&<p>Asset ID: {String(result.assetId)}</p>}
 </main>;
}
