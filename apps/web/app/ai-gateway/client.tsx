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
 const [duplicateBusy,setDuplicateBusy]=useState(false);
 const [duplicateResult,setDuplicateResult]=useState<ApiResult|null>(null);
 const [duplicateError,setDuplicateError]=useState("");
 const [globalBusy,setGlobalBusy]=useState(false);
 const [globalResult,setGlobalResult]=useState<ApiResult|null>(null);
 const [globalError,setGlobalError]=useState("");

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
    setRegistrationResult(null);setRegistrationError("");setDuplicateResult(null);setDuplicateError("");
    setGlobalResult(null);setGlobalError("");
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

 async function inspectDuplicateProtection(){
  if(duplicateBusy||busy||testBusy||registrationBusy)return;
  if(registrationResult?.registrationVerified!==true||
     typeof registrationResult.dropboxPath!=="string"||
     typeof registrationResult.dropboxFileId!=="string"||
     registrationResult.assetId!==testAssetId)return;
  setDuplicateBusy(true);setDuplicateError("");setDuplicateResult(null);
  try{
   const result=await gateway({
    action:"inspect_brand_registration",brandSlug:brand,path:registrationResult.dropboxPath
   });
   const existing=result.asset as {id?:unknown}|null|undefined;
   const matches=result.registrationStatus==="registered"&&
    existing?.id===testAssetId&&
    result.dropboxFileId===registrationResult.dropboxFileId&&
    result.safeToRegister===false;
   setDuplicateResult({...result,preflightMatchVerified:matches});
  }catch(e){setDuplicateError(e instanceof Error?e.message:"Duplicate preflight unavailable");}
  finally{setDuplicateBusy(false);}
 }

 async function inspectGlobalIdentity(){
  if(!testAssetId||busy||testBusy||registrationBusy||duplicateBusy||globalBusy)return;
  setGlobalBusy(true);setGlobalError("");setGlobalResult(null);
  try{
   const result=await gateway({
    action:"inspect_global_dropbox_id",brandSlug:brand,assetId:testAssetId
   });
   setGlobalResult(result);
  }catch(e){setGlobalError(e instanceof Error?e.message:"Global Dropbox ID lookup unavailable");}
  finally{setGlobalBusy(false);}
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
      setBrand(event.target.value);setCandidates([]);setTestAssetId("");setTestResult(null);setRegistrationResult(null);setRegistrationError("");setDuplicateResult(null);setDuplicateError("");setGlobalResult(null);setGlobalError("");
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
   {error&&<p role="alert" style={{color:"#ff9b8f"}}>{error}</p>}
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
      <select value={testAssetId} disabled={busy||testBusy} onChange={event=>{setTestAssetId(event.target.value);setRegistrationResult(null);setDuplicateResult(null);setGlobalResult(null);}}>
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
   {testError&&<p role="alert" style={{color:"#ff9b8f"}}>{testError}</p>}
   {testResult&&<div style={{marginTop:16}}>
    <strong style={{color:testResult.ok?"#2efd7c":"#ff9b8f"}}>
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
      <select value={testAssetId} disabled={busy||testBusy||registrationBusy} onChange={event=>{setTestAssetId(event.target.value);setRegistrationResult(null);setDuplicateResult(null);}}>
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
   {registrationError&&<p role="alert" style={{color:"#ff9b8f"}}>{registrationError}</p>}
   {registrationResult&&<div style={{marginTop:16}}>
    <strong style={{color:registrationResult.registrationVerified===true?"#2efd7c":"#fbbf24"}}>
     {registrationResult.registrationVerified===true?"PASS · Dropbox source identity verified":"NEEDS REVIEW · Dropbox source identity not yet verified"}
    </strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",overflow:"auto",maxHeight:400,marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(registrationResult,null,2)}
    </pre>
    {registrationResult.registrationVerified!==true&&<p className="muted" style={{fontSize:12}}>This result does not mean the file is a duplicate. It means the database did not expose enough matching Dropbox identity information, or the source needs review. No changes were made.</p>}
   </div>}
  </section>
  <section className="card" style={{marginTop:18}}>
   <h2 style={{marginTop:0}}>Step 6 · Duplicate registration preflight</h2>
   <p className="muted">
    Check that the gateway's registration lookup recognizes this same Dropbox file ID as an
    existing asset. This test only reads Elettro and Dropbox; it never registers an asset,
    creates a duplicate, or changes its Ready / Approved status.
   </p>
   {registrationResult?.registrationVerified!==true||
     registrationResult.assetId!==testAssetId?
     <p className="muted">First run <strong>Verify existing registration (read-only)</strong> in Step 5 above.</p>:
     <div>
      <p className="muted" style={{fontSize:12}}>Using the verified Dropbox file path from Step 5. No file selection or new upload required.</p>
      <button type="button" disabled={busy||testBusy||registrationBusy||duplicateBusy} onClick={()=>void inspectDuplicateProtection()}>
       {duplicateBusy?"Checking duplicate registration…":"Check existing asset for duplicates (read-only)"}
      </button>
     </div>}
   {duplicateBusy&&<p role="status">Checking the immutable Dropbox ID against the asset registry…</p>}
   {duplicateError&&<p role="alert" style={{color:"#ff9b8f"}}>{duplicateError}</p>}
   {duplicateResult&&<div style={{marginTop:16}}>
    <strong style={{color:duplicateResult.preflightMatchVerified===true?"#2efd7c":"#fbbf24"}}>
     {duplicateResult.preflightMatchVerified===true?
      "PASS · Existing registration recognized; no duplicate created":
      "NEEDS REVIEW · Existing registration was not conclusively identified"}
    </strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:390,overflow:"auto",marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(duplicateResult,null,2)}
    </pre>
    <p className="muted" style={{fontSize:12}}>
     This is a read-only preflight result, not an end-to-end registration write test.
     New AI registrations remain paused until a full-database Dropbox-ID lookup is available.
    </p>
   </div>}
  </section>
  <section className="card" style={{marginTop:18}}>
   <h2 style={{marginTop:0}}>Step 7 · Database-wide Dropbox ID lookup</h2>
   <p className="muted">Independently verify the selected asset across the <strong>entire Elettro registry</strong>, not only the latest 500 assets. This test uses the database only: no Dropbox token, upload, registration, metadata write, or publishing action.</p>
   {candidates.length===0?
    <p className="muted">Search for brand assets above to select one for this test.</p>:
    <div style={{display:"grid",gap:10,maxWidth:680}}>
     <label style={{display:"grid",gap:5}}>
      <span className="metric">Asset to verify</span>
      <select value={testAssetId} disabled={busy||testBusy||registrationBusy||duplicateBusy||globalBusy}
       onChange={event=>{setTestAssetId(event.target.value);setRegistrationResult(null);setDuplicateResult(null);setGlobalResult(null);}}>
       {candidates.map(asset=><option key={asset.id} value={asset.id}>
        {asset.filename.slice(0,110)} · {asset.id.slice(0,8)}
       </option>)}
      </select>
     </label>
     <div>
      <button type="button" disabled={busy||testBusy||registrationBusy||duplicateBusy||globalBusy||!testAssetId}
       onClick={()=>void inspectGlobalIdentity()}>
       {globalBusy?"Checking full database…":"Verify Dropbox ID across all assets (read-only)"}
      </button>
     </div>
    </div>}
   {globalBusy&&<p role="status">Searching both Dropbox ID fields across the entire database…</p>}
   {globalError&&<p role="alert" style={{color:"#ff9b8f"}}>{globalError}</p>}
   {globalResult&&<div style={{marginTop:16}}>
    <strong style={{color:globalResult.globalLookupVerified===true?"#2efd7c":"#fbbf24"}}>
     {globalResult.globalLookupVerified===true?
      "PASS · Global Dropbox identity lookup verified":
      "NEEDS REVIEW · Global Dropbox identity not verified"}
    </strong>
    <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:400,overflow:"auto",marginTop:10,padding:14,border:"1px solid var(--line)",borderRadius:10,background:"var(--panel-soft)",fontSize:12}}>
     {JSON.stringify(globalResult,null,2)}
    </pre>
    <p className="muted" style={{fontSize:12}}>
     This is an authoritative lookup, not a registration-write test.
     New AI registration remains disabled until atomic uniqueness is enforced at the database level.
    </p>
   </div>}
  </section>
  <p className="muted" style={{marginTop:18,fontSize:12}}>
   The external ChatGPT and Claude connector setup remains separate. This page does not configure assistant credentials.
  </p>
 </>;
}
