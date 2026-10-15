import { enrichAfterRegistrationIfEnabled } from "@/lib/asset-ai-enrichment";
import {createHash} from "node:crypto";
import {SecretsManagerClient,GetSecretValueCommand} from "@aws-sdk/client-secrets-manager";
import {brandConfigs} from "@/lib/brand-config";
import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";
import {validChatFile,verifyIntakePlan,mediaType,type ChatFile} from "@/lib/ai-mcp-intake";
import {approvedChatGptFileHost} from "@/lib/ai-mcp-file-hosts";
import {verifyDropboxFileResponse} from "@/lib/ai-mcp-dropbox-identity";
import type {McpIdentity} from "@/lib/ai-mcp-auth";

const MAX_BYTES=20*1024*1024; // Pilot cap. Large videos need a resumable background worker.
const MAX_PAGES=200;
const API_BASE=process.env.BRAND_OS_API_BASE_URL ||
 process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
 "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const secrets=new SecretsManagerClient({region:"us-east-1"});
type Obj=Record<string,unknown>;

function inputRecord(value:unknown):Obj{
 if(!value||typeof value!=="object"||Array.isArray(value))
  throw new GatewayError(400,"Invalid upload arguments");
 return value as Obj;
}
export const approvedFileHost=approvedChatGptFileHost;
export function validatedDownloadUrl(value:string):string{
 let url:URL;
 try{url=new URL(value);}
 catch{throw new GatewayError(400,"Invalid ChatGPT file URL");}
 // Never reveal the temporary signed URL, path, query, or bearer credentials.
 // This diagnostic exposes only the normalized hostname for a denied host.
 if(url.protocol!=="https:"||url.port||url.username||url.password||
    url.hash||url.href.length>6000)
  throw new GatewayError(403,"ChatGPT file URL failed secure URL checks; no download attempted");
 if(!approvedFileHost(url.hostname))
  throw new GatewayError(403,
   "ChatGPT attachment download host not yet approved: "+url.hostname.slice(0,200)+
   " (only hostname reported; no download attempted)");
 return url.href;
}
async function downloadChatFile(file:ChatFile):Promise<Buffer>{
 const url=validatedDownloadUrl(file.download_url);
 let response:Response;
 try{
  response=await fetch(url,{method:"GET",redirect:"error",cache:"no-store",
   signal:AbortSignal.timeout(45000)});
 }catch{throw new GatewayError(502,"Authorized ChatGPT file could not be downloaded; refresh its file reference");}
 if(!response.ok||!response.body)
  throw new GatewayError(502,"ChatGPT file download unavailable");
 const advertised=Number(response.headers.get("content-length")||0);
 if(advertised>MAX_BYTES)
  throw new GatewayError(413,"File is over 20 MB pilot limit; use Elettro dashboard for large video until resumable AI uploads are enabled");
 // Streaming bound: prevent untrusted content-length from forcing a huge Buffer.
 const reader=response.body.getReader();const parts:Buffer[]=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>MAX_BYTES)throw new GatewayError(413,"File exceeds 20 MB pilot limit");
   parts.push(Buffer.from(value));
  }
 }finally{await reader.cancel().catch(()=>{});}
 if(size<1)throw new GatewayError(400,"ChatGPT file has no content");
 return Buffer.concat(parts,size);
}
// Dropbox content hash: SHA-256 of consecutive 4-MiB chunk SHA-256 hashes.
export function dropboxContentHash(buffer:Buffer):string{
 const blocks=createHash("sha256");
 const CHUNK=4*1024*1024;
 for(let pos=0;pos<buffer.length;pos+=CHUNK)
  blocks.update(createHash("sha256").update(buffer.subarray(pos,Math.min(pos+CHUNK,buffer.length))).digest());
 return blocks.digest("hex");
}
export async function dropboxToken():Promise<string>{
 const response=await secrets.send(new GetSecretValueCommand({SecretId:"elettro-brand-os-dev/dropbox"}));
 const cfg=JSON.parse(response.SecretString||"{}") as Record<string,string>;
 const refresh=cfg.refresh_token||cfg.refreshToken;
 const key=cfg.app_key||cfg.appKey;
 const password=cfg.app_secret||cfg.appSecret;
 if(!refresh||!key||!password)throw new GatewayError(503,"Dropbox credentials unavailable");
 const result=await fetch("https://api.dropboxapi.com/oauth2/token",{
  method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
  body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,
   client_id:key,client_secret:password}),cache:"no-store",
  signal:AbortSignal.timeout(10000)
 });
 if(!result.ok)throw new GatewayError(503,"Dropbox access token unavailable");
 const json=await result.json() as {access_token?:string};
 if(!json.access_token)throw new GatewayError(503,"Dropbox token missing");
 return json.access_token;
}
export async function metadata(token:string,path:string){
 const r=await fetch("https://api.dropboxapi.com/2/files/get_metadata",{
  method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
  body:JSON.stringify({path}),cache:"no-store",
  signal:AbortSignal.timeout(12000)
 });
 if(r.status===409){
  const data=await r.json().catch(()=>null) as {
   error?:{".tag"?:string;path?:{".tag"?:string}}
  }|null;
  if(data?.error?.[".tag"]==="path"&&data?.error?.path?.[".tag"]==="not_found")return null;
 }
 if(!r.ok)throw new GatewayError(502,"Dropbox destination check failed");
 return await r.json() as {".tag":string;id?:string;size?:number;content_hash?:string;path_display?:string};
}
export async function matchingBrandFile(token:string,root:string,size:number,hash:string){
 let cursor:string|undefined, pages=0;
 do{
  if(++pages>MAX_PAGES)throw new GatewayError(503,"Exhaustive Dropbox inventory too large; upload stopped");
  const endpoint=cursor?"list_folder/continue":"list_folder";
  const r=await fetch("https://api.dropboxapi.com/2/files/"+endpoint,{
   method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
   body:JSON.stringify(cursor?{cursor}:{path:root,recursive:true,
    include_deleted:false,limit:2000}),cache:"no-store",
   signal:AbortSignal.timeout(15000)
  });
  if(!r.ok)throw new GatewayError(503,"Dropbox duplicate scan failed; upload stopped");
  const data=await r.json() as {entries:Array<{".tag":string;id?:string;size?:number;content_hash?:string;path_display?:string}>;has_more:boolean;cursor:string};
  const match=data.entries.find(v=>v[".tag"]==="file"&&v.size===size&&
    v.content_hash?.toLowerCase()===hash&&typeof v.id==="string"&&
    v.path_display?.toLowerCase().startsWith(root.toLowerCase()+"/"));
  if(match)return {id:match.id!,path:match.path_display!};
  cursor=data.has_more?data.cursor:undefined;
 }while(cursor);
 return null;
}
async function putDropbox(token:string,path:string,bytes:Buffer,contentHash:string){
 const r=await fetch("https://content.dropboxapi.com/2/files/upload",{
  method:"POST",
  headers:{authorization:"Bearer "+token,
   "content-type":"application/octet-stream",
   "dropbox-api-arg":JSON.stringify({path,mode:"add",autorename:false,mute:false,
    strict_conflict:true})},
  body:new Uint8Array(bytes),cache:"no-store",signal:AbortSignal.timeout(60000)
 });
 if(!r.ok){
  if(r.status===409)throw new GatewayError(409,"Dropbox filename or upload conflict. Nothing was overwritten.");
  throw new GatewayError(502,"Dropbox upload failed (HTTP "+r.status+"); nothing overwritten");
 }
 // Dropbox upload returns FileMetadata without necessarily including ".tag".
 // Verify the response and then ask Dropbox to independently confirm the
 // persisted file ID and its exact content bytes before registration.
 let uploaded;
 try{uploaded=verifyDropboxFileResponse(await r.json(),path,bytes.length,contentHash);}
 catch{throw new GatewayError(502,"Dropbox upload response did not match the requested file. Check the destination before retrying.");}
 const stored=await metadata(token,uploaded.id);
 let verified;
 try{verified=verifyDropboxFileResponse(stored,path,bytes.length,contentHash);}
 catch{throw new GatewayError(502,"Dropbox stored file verification failed. Check the destination before retrying.");}
 if(verified.id!==uploaded.id)
  throw new GatewayError(502,"Dropbox uploaded file identity changed. Check the destination before retrying.");
 return verified;
}
async function apiAction(body:Obj):Promise<Obj>{
 const r=await fetch(API_BASE+"/assets/bulk-update",{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify(body),cache:"no-store",signal:AbortSignal.timeout(20000)
 });
 const data=await r.json().catch(()=>null) as Obj|null;
 if(!r.ok||!data||data.ok===false)
  throw new GatewayError(502,"Elettro registry registration failed after Dropbox operation");
 return data;
}

export async function uploadApprovedChatFile(args:unknown,identity:McpIdentity){
 const command=inputRecord(args);
 if(command.confirmed!==true)
  throw new GatewayError(400,"Explicit owner confirmation is required to upload a file");
 if(!identity.permissions.includes("assets:upload"))
  throw new GatewayError(403,"Asset upload scope not granted");
 const file=validChatFile(command.file);
 const plan=await verifyIntakePlan(command.planToken,identity,file);
 if(mediaType(plan.filename)!==plan.mimeType)
  throw new GatewayError(403,"Signed file type mismatch");
 if(!/^(image|video)\//.test(plan.mimeType))
  throw new GatewayError(400,"Audio upload awaits separate registry validation; only images and video are enabled in the pilot");
 // The same actual folder must still exist at commit time.
 await executeAiGateway({action:"list_folders",scope:"brand",
  brandSlug:plan.brandSlug,path:plan.folder});
 const root=brandConfigs.find(v=>v.id===plan.brandSlug)?.dropboxRoot;
 if(!root)throw new GatewayError(403,"Invalid upload brand");
 const bytes=await downloadChatFile(file);
 const contentHash=dropboxContentHash(bytes);
 const token=await dropboxToken();
 const existing=await matchingBrandFile(token,root,bytes.length,contentHash);
 const target=plan.folder+"/"+plan.filename;
 let fileIdentity:{id:string;path:string;contentHash?:string;size?:number};
 let reused=false;
 if(existing){
  fileIdentity=existing;reused=true;
 }else{
  const present=await metadata(token,target);
  if(present){
   // Dropbox get_metadata also returns FileMetadata with an optional ".tag".
   // Never overwrite a conflicting filename; only reuse an exact byte match.
   try{fileIdentity=verifyDropboxFileResponse(present,target,bytes.length,contentHash);}
   catch{throw new GatewayError(409,"Target filename already exists with different bytes; no overwrite");}
   reused=true;
  }else{
   fileIdentity=await putDropbox(token,target,bytes,contentHash);
  }
 }
 if(!fileIdentity.id.startsWith("id:"))
  throw new GatewayError(502,"Invalid Dropbox immutable file ID");
 // Do not register a file unless the exact bytes at the final Dropbox
 // path are verified. Fail-safe response keeps its path for reconciliation.
 const registeredMetadata={
  title:plan.metadata.title,topic:plan.metadata.topic||"",
  creativeFamily:plan.metadata.creativeFamily||"",
  collection:plan.metadata.contentGroup||"",
  creatorNote:plan.metadata.creativeNotes||"",
  tags:plan.metadata.tags,priority:plan.metadata.priority,
  sendToApprovalQueue:false,allowedDestinations:[],
  eligibilityMode:"evergreen"
 };
 let result:Obj;
 try{
  result=await apiAction({action:"complete-dropbox-upload",brandSlug:plan.brandSlug,
   path:fileIdentity.path,mode:"ready",metadata:registeredMetadata});
 }catch{
  return {ok:false,registrationPending:true,brandSlug:plan.brandSlug,
   dropboxFileId:fileIdentity.id,dropboxPath:fileIdentity.path,reusedExistingFile:reused,
   message:"Dropbox file exists, but Elettro registration did not finish. Do not upload it again; reconcile this Dropbox ID and path."};
 }
 const asset=result.asset && typeof result.asset==="object"&&!Array.isArray(result.asset)
  ?result.asset as Obj:null;
 const id=asset&&typeof asset.id==="string"?asset.id:undefined;
 if(!id){
  return {ok:false,registrationPending:true,dropboxFileId:fileIdentity.id,
   dropboxPath:fileIdentity.path,reusedExistingFile:reused,
   message:"Registry did not provide an asset ID; no duplicate re-upload should be attempted."};
 }
 try{
  // Enforce the final title/notes through the same existing owner-confirmed
  // metadata update path, without altering Ready/Approved or publish state.
  await executeAiGateway({action:"update_asset_metadata",brandSlug:plan.brandSlug,
   assetId:id,metadata:plan.metadata,confirmed:true});
  const identityCheck=await executeAiGateway({action:"inspect_global_dropbox_id",
   brandSlug:plan.brandSlug,assetId:id});
  if(identityCheck.globalLookupVerified!==true)
   throw new GatewayError(502,"Global Dropbox identity was not confirmed");
  const locationCheck=await executeAiGateway({action:"inspect_registered_asset",
   brandSlug:plan.brandSlug,assetId:id});
  if(locationCheck.verificationStatus!=="registered_in_dropbox" &&
     locationCheck.verificationStatus!=="registered_file_moved")
   throw new GatewayError(502,"Dropbox file identity verification unavailable");
  const enrichment=await enrichAfterRegistrationIfEnabled(plan.brandSlug,id);
  return {ok:true,assetId:id,brandSlug:plan.brandSlug,
   ...(enrichment.attempted?{autoEnrichment:enrichment}:{}),
   dropboxFileId:fileIdentity.id,dropboxPath:fileIdentity.path,
   filename:plan.filename,reusedExistingFile:reused,metadata:plan.metadata,
   registered:true,identityVerified:true,
   note:"Saved to existing brand folder with metadata, no S3 transfer or publishing. Existing Approved status is preserved."};
 }catch{
  return {ok:false,metadataOrVerificationPending:true,assetId:id,
   dropboxFileId:fileIdentity.id,dropboxPath:fileIdentity.path,reusedExistingFile:reused,
   message:"Dropbox storage and Elettro registration completed, but metadata or identity follow-up needs review. Do not upload again."};
 }
}

