"use client";
import {useState} from "react";

type Asset={id:string;filename:string;tags?:string[];ingestStatus?:string;approvalStatus?:string};
type ApiResult={ok:boolean;assets?:Asset[];error?:string;[key:string]:unknown};
const brands=[
 {id:"stashbox",name:"Stashbox"},
 {id:"elettro",name:"Elettro"},
 {id:"solarmeister",name:"SolarMeister"},
 {id:"weightlossdavie",name:"WeightLossDavie"},
 {id:"neckermann-strom",name:"Neckermann Strom"},
 {id:"therasbox",name:"Therasbox"}
];

async function gateway(request:Record<string,unknown>):Promise<ApiResult>{
 const response=await fetch("/api/ai-gateway",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify(request),cache:"no-store"
 });
 const result=await response.json() as ApiResult;
 if(!response.ok)throw new Error(result.error||"Gateway request failed");
 return result;
}

export function AiGatewayLabClient(){
 const [brand,setBrand]=useState("stashbox");
 const [query,setQuery]=useState("");
 const [busy,setBusy]=useState(false);
 const [current,setCurrent]=useState("");
 const [error,setError]=useState("");
 const [reply,setReply]=useState<unknown>(null);
 const [candidates,setCandidates]=useState<Asset[]>([]);
 const [testAssetId,setTestAssetId]=useState("");
 const [testBusy,setTestBusy]=useState(false);
 const [testResult,setTestResult]=useState<ApiResult|null>(null);
 const [testError,setTestError]=useState("");
 const [registrationBusy,setRegistrationBusy]=useState(false);
 const [registrationResult,setRegistrationResult]=useState<ApiResult|null>(null);
 const [registrationError,setRegistrationError]=useState("");

 async function call(action:"capabilities"|"search_assets"|"list_folders"){
  setBusy(true);setError("");setCurrent(action);setReply(null);
  try{
   const args=action==="search_assets"?{action,brandSlug:brand,query,limit:10}:
    action==="list_folders"?{action,scope:"brand",brandSlug:brand}:{action};
   const result=await gateway(args);
   if(!result.ok)throw new Error(result.error||"Gateway returned an error");
   setReply(result);
   if(action==="search_assets"){
    const assets=result.assets||[];
    setCandidates(assets);
    setRegistrationResult(null);setRegistrationError("");
    setTestAssetId(currentId=>assets.some(a=>a.id===currentId)?currentId:(assets[0]?.id||""));
   }
  }catch(e){setError(e instanceof Error?e.message:"Gateway unavailable");}
  finally{setBusy(false);}
 }

 async function inspectRegistration(){
  if(!testAssetId||registrationBusy||testBusy||busy)return;
  setRegistrationBusy(true);setRegistrationError("");setRegistrationResult(null);
  try{
   const result=await gateway({
    action:"inspect_registered_asset",brandSlug:brand,assetId:testAssetId
   });
   setRegistrationResult(result);
  }catch(e){setRegistrationError(e instanceof Error?e.message:"Asset verification unavailable");}
  finally{setRegistrationBusy(false);}
 }

 async function testMetadata(){
  if(brand!=="stashbox"||!testAssetId||busy||testBusy)return;
  const choice=candidates.find(asset=>asset.id===testAssetId);
  if(!choice)return;
  if(!window.confirm(
   "Run a temporary metadata write test on "+choice.filename+
   "? The gateway will add a unique test tag, verify it, remove it, and verify restoration. "+
   "The asset stays in its current publishing status."
  ))return;
  setTestBusy(true);setTestError("");setTestResult(null);
  try{
   const result=await gateway({action:"test_metadata_round_trip",assetId:testAssetId,confirmed:true});
   setTestResult(result);
  }catch(e){setTestError(e instanceof Error?e.message:"Write test unavailable");}
  finally{setTestBusy(false);}
 }

 return <>
  <section className="card" style={{marginTop:18}}>
   <h2 style={{marginTop:0}}>Read-only smoke tests</h2>
   <p className="muted">These buttons inspect the gateway without creating, moving, deleting, registering or publishing assets.</p>
   <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"end"}}>
    <label style={{display:"grid",gap:5}}>
     <span className="metric">Brand</span>
     <select value={brand} onChange={event=>{
      setBrand(event.target.value);setCandidates([]);setTestAssetId("");setTestResult(null);setRegistrationResult(null);setRegistrationError("");
     }} disabled={busy||testBusy}>
      {brands.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
     </select>
    </label>
    <label style={{display:"grid",gap:5}}>
     <span className="metric">Asset search</span>
     <input value={query} maxLength={160} onChange={event=>setQuery(event.target.value)}
      placeholder="Title, tags, filename..." disabled={busy||testBusy}/>
    </label>
   </div>
   <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:14}}>
    <button type="button" disabled={busy||testBusy} onClick={()=>void call("capabilities")}>Check API</button>
    <button type="button" disabled={busy||testBusy} onClick={()=>void call("search_assets")}>Search brand assets</button>
    <button type="button" disabled={busy||testBusy} onClick={()=>void call("list_folders")}>Browse brand root</button>
   </div>
   {busy&&<p role="status" className="muted">Checking {current.replaceAll("_"," ")}…</p>}
   {error&&<p role="alert" style={{color:"#b42318"}}>{error}</p>}
   {reply!==null&&<div style={{marginTop:16}}>
    <strong>{current.replaceAll("_"," ")} succeeded</strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",overflow:"auto",maxHeight:400,marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(reply,null,2)}
    </pre>
   </div>}
  </section>

  <section className="card" style={{marginTop:18}}>
   <h2 style={{marginTop:0}}>Step 4 · Metadata write and restoration test</h2>
   <p className="muted">Select a Stashbox asset from the search results above. The gateway adds one temporary test tag, confirms it was saved, then removes the tag and verifies the original metadata and publishing status. Dropbox files are not modified.</p>
   {brand!=="stashbox"?<p className="muted">This first write test is limited to Stashbox. Select Stashbox above to continue.</p>:
    candidates.length===0?<p className="muted">Click <strong>Search brand assets</strong> above first to load test candidates.</p>:
    <div style={{display:"grid",gap:10,maxWidth:680}}>
     <label style={{display:"grid",gap:5}}>
      <span className="metric">Test asset</span>
      <select value={testAssetId} disabled={busy||testBusy} onChange={event=>setTestAssetId(event.target.value)}>
       {candidates.map(asset=><option key={asset.id} value={asset.id}>
        {asset.filename.slice(0,110)} · {asset.id.slice(0,8)}
       </option>)}
      </select>
     </label>
     <p className="muted" style={{margin:0,fontSize:12}}>This test writes a temporary tag, so a brief metadata change may be visible while it runs. It does not change approval, readiness, destinations or file locations.</p>
     <div>
      <button type="button" disabled={busy||testBusy||!testAssetId} onClick={()=>void testMetadata()}>
       {testBusy?"Writing, verifying and restoring…":"Run write + restore test"}
      </button>
     </div>
    </div>}
   {testBusy&&<p role="status">Running the test and restoring the original tags. Please wait for the final result.</p>}
   {testError&&<p role="alert" style={{color:"#b42318"}}>{testError}</p>}
   {testResult&&<div style={{marginTop:16}}>
    <strong style={{color:testResult.ok?"#116c46":"#b42318"}}>
     {testResult.ok?"PASS · Metadata write and restoration verified":"ATTENTION · Test or restoration needs review"}
    </strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",overflow:"auto",maxHeight:400,marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(testResult,null,2)}
    </pre>
   </div>}
  </section>
  <section className="card" style={{marginTop:18}}>
   <h2 style={{marginTop:0}}>Step 5 · Registration and Dropbox identity check</h2>
   <p className="muted">Check that a registered brand asset still points to its original Dropbox file. This is read-only and will not register anything twice or change publishing status.</p>
   {candidates.length===0?<p className="muted">Search for brand assets above to select one for verification.</p>:
    <div style={{display:"grid",gap:10,maxWidth:680}}>
     <label style={{display:"grid",gap:5}}>
      <span className="metric">Registered asset to inspect</span>
      <select value={testAssetId} disabled={busy||testBusy||registrationBusy} onChange={event=>{setTestAssetId(event.target.value);setRegistrationResult(null);}}>
       {candidates.map(asset=><option key={asset.id} value={asset.id}>
        {asset.filename.slice(0,110)} · {asset.id.slice(0,8)}
       </option>)}
      </select>
     </label>
     <div><button type="button" disabled={busy||testBusy||registrationBusy||!testAssetId} onClick={()=>void inspectRegistration()}>
      {registrationBusy?"Checking Dropbox identity…":"Verify existing registration (read-only)"}
     </button></div>
    </div>}
   {registrationBusy&&<p role="status">Checking asset record and its Dropbox identity…</p>}
   {registrationError&&<p role="alert" style={{color:"#b42318"}}>{registrationError}</p>}
   {registrationResult&&<div style={{marginTop:16}}>
    <strong style={{color:registrationResult.registrationVerified===true?"#116c46":"#b45309"}}>
     {registrationResult.registrationVerified===true?"PASS · Dropbox source identity verified":"NEEDS REVIEW · Dropbox source identity not yet verified"}
    </strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",overflow:"auto",maxHeight:400,marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(registrationResult,null,2)}
    </pre>
    {registrationResult.registrationVerified!==true&&<p className="muted" style={{fontSize:12}}>This result does not mean the file is a duplicate. It means the database did not expose enough matching Dropbox identity information, or the source needs review. No changes were made.</p>}
   </div>}
  </section>
  <p className="muted" style={{marginTop:18,fontSize:12}}>
   The external ChatGPT and Claude connector setup remains separate. This page does not configure assistant credentials.
  </p>
 </>;
}
