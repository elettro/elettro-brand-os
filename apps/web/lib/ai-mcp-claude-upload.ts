import { enrichAfterRegistrationIfEnabled } from "@/lib/asset-ai-enrichment";
import {createHmac,timingSafeEqual} from "node:crypto";
import {serverSetting} from "@/lib/cognito-auth";
import {brandConfigs} from "@/lib/brand-config";
import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";
import {safeFilename,mediaType,normalizedMetadata,insideBrand} from "@/lib/ai-mcp-intake";
import {dropboxToken,metadata,matchingBrandFile} from "@/lib/ai-mcp-upload";
import {verificationFailed,type VerificationStep} from "@/lib/ai-mcp-upload-result";
import type {McpIdentity} from "@/lib/ai-mcp-auth";

type Obj=Record<string,unknown>;
type Transfer={version:1;kind:"transfer";provider:string;brandSlug:string;filename:string;path:string;size:number;
 contentHash:string;metadata:ReturnType<typeof normalizedMetadata>;expiresAt:number};
const API_BASE=process.env.BRAND_OS_API_BASE_URL||process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL||
 "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
function obj(value:unknown):Obj{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new GatewayError(400,"Invalid transfer arguments");
 return value as Obj;
}
async function signature(body:string){
 const key=await serverSetting("ELETTRO_AUTH_SESSION_SECRET");
 if(key.length<32)throw new GatewayError(503,"Transfer signing unavailable");
 return createHmac("sha256",key).update("claude-transfer-v1:"+body).digest("base64url");
}
async function seal(plan:object){
 const body=Buffer.from(JSON.stringify(plan)).toString("base64url");
 return body+"."+await signature(body);
}
async function open(value:unknown,identity:McpIdentity,slug:unknown):Promise<Transfer>{
 if(typeof value!=="string"||value.length>12000)throw new GatewayError(400,"Invalid transfer token");
 const dot=value.lastIndexOf("."),body=value.slice(0,dot);
 const given=Buffer.from(value.slice(dot+1)),expected=Buffer.from(await signature(body));
 if(dot<1||given.length!==expected.length||!timingSafeEqual(given,expected))
  throw new GatewayError(403,"Invalid transfer signature");
 let plan:Transfer;
 try{plan=JSON.parse(Buffer.from(body,"base64url").toString());}catch{throw new GatewayError(400,"Invalid transfer plan");}
 if(plan.version!==1||plan.kind!=="transfer"||plan.provider!==identity.clientId||plan.brandSlug!==slug||
  !identity.brandSlugs.includes(plan.brandSlug)||!insideBrand(plan.brandSlug,plan.path)||
  !Number.isFinite(plan.expiresAt)||plan.expiresAt<Date.now())
  throw new GatewayError(403,"Transfer expired or belongs to another connection/brand");
 return plan;
}
function allowed(identity:McpIdentity,command:Obj){
 if(!["claude_code","claude_web"].includes(identity.clientId)||
  !identity.permissions.includes("assets:upload")||!identity.permissions.includes("assets:write")||
  !identity.brandSlugs.includes(String(command.brandSlug)))throw new GatewayError(403,"Claude upload not authorized");
 if(command.confirmed!==true)throw new GatewayError(400,"Confirm the destination and metadata before transfer");
}
export async function prepareClaudeTransfer(args:unknown,identity:McpIdentity){
 const command=obj(args);allowed(identity,command);
 const config=brandConfigs.find(v=>v.id===command.brandSlug);
 if(!config)throw new GatewayError(403,"Unknown brand");
 const filename=safeFilename(command.filename);
 if(!/^(image|video)\//.test(mediaType(filename)))throw new GatewayError(400,"Only images and video can currently be registered");
 const folder=String(command.folder||"");
 if(!insideBrand(config.id,folder))throw new GatewayError(403,"Choose a folder within the selected brand");
 const size=command.size;
 if(typeof size!=="number"||!Number.isSafeInteger(size)||size<1||size>20*1024*1024)
  throw new GatewayError(400,"Transfer limit is 20 MiB");
 if(typeof command.contentHash!=="string"||!/^[a-f0-9]{64}$/.test(command.contentHash))
  throw new GatewayError(400,"Provide the Dropbox content hash computed from the actual file bytes");
 const draft=normalizedMetadata(command.metadata,filename);
 await executeAiGateway({action:"list_folders",scope:"brand",brandSlug:config.id,path:folder});
 const token=await dropboxToken();
 const duplicate=await matchingBrandFile(token,config.dropboxRoot,size,command.contentHash);
 const target=folder+"/"+filename;
 const present=duplicate?null:await metadata(token,target);
 if(present&&(present[".tag"]!=="file"||present.size!==size||present.content_hash!==command.contentHash))
  throw new GatewayError(409,"Destination already exists with different content; choose a new filename");
 const path=duplicate?.path||present?.path_display||target;
 const plan:Transfer={version:1,kind:"transfer",provider:identity.clientId,brandSlug:config.id,filename,path,size,
  contentHash:command.contentHash,metadata:draft,expiresAt:Date.now()+30*60*1000};
 const transferToken=await seal(plan);
 if(duplicate||present)return {ok:true,reusedExistingFile:true,uploadRequired:false,
  brandSlug:config.id,dropboxPath:path,transferToken,metadata:draft};
 const r=await fetch("https://api.dropboxapi.com/2/files/get_temporary_upload_link",{
  method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
  body:JSON.stringify({commit_info:{path,mode:"add",autorename:false,mute:false,strict_conflict:true},duration:1800}),
  cache:"no-store",signal:AbortSignal.timeout(15000)
 });
 if(!r.ok)throw new GatewayError(502,"Dropbox upload link unavailable");
 const result=await r.json() as {link?:string};
 if(!result.link?.startsWith("https://"))throw new GatewayError(502,"Invalid Dropbox upload link");
 return {ok:true,uploadRequired:true,reusedExistingFile:false,brandSlug:config.id,dropboxPath:path,
  uploadUrl:result.link,transferToken,metadata:draft,expiresInMinutes:30,
  instruction:"POST the actual file bytes to uploadUrl with Content-Type application/octet-stream, then call elettro_complete_file_transfer. If you cannot access/send the bytes, say so; never invent a file URL or content hash."};
}
export async function completeClaudeTransfer(args:unknown,identity:McpIdentity){
 const command=obj(args);allowed(identity,command);
 const plan=await open(command.transferToken,identity,command.brandSlug);
 const actual=await metadata(await dropboxToken(),plan.path);
 if(!actual||actual[".tag"]!=="file"||!actual.id||actual.size!==plan.size||actual.content_hash!==plan.contentHash)
  throw new GatewayError(409,"Uploaded bytes do not match the signed file size/hash; registration stopped");
 const path=actual.path_display||plan.path;
 const pending={ok:false,registrationPending:true,brandSlug:plan.brandSlug,dropboxPath:path,dropboxFileId:actual.id,
  message:"File exists in Dropbox. Do not upload again; retry completion or reconcile this Dropbox ID."};
 let data:Obj;
 try{
  const response=await fetch(API_BASE+"/assets/bulk-update",{
   method:"POST",headers:{"content-type":"application/json"},cache:"no-store",signal:AbortSignal.timeout(20000),
   body:JSON.stringify({action:"complete-dropbox-upload",brandSlug:plan.brandSlug,path,mode:"raw",
    metadata:{sendToApprovalQueue:false,allowedDestinations:[],eligibilityMode:"evergreen"}})
  });
  data=obj(await response.json());
  if(!response.ok||data.ok===false)return pending;
 }catch{return pending;}
 const asset=data.asset&&typeof data.asset==="object"?data.asset as Obj:null;
 if(typeof asset?.id!=="string")return pending;
 let step:VerificationStep="metadata";
 try{
  await executeAiGateway({action:"update_asset_metadata",brandSlug:plan.brandSlug,assetId:asset.id,
   metadata:plan.metadata,confirmed:true});
  step="global_identity";
  const check=await executeAiGateway({action:"inspect_global_dropbox_id",brandSlug:plan.brandSlug,assetId:asset.id});
  if(check.globalLookupVerified!==true)throw new Error("Verification pending");
  step="dropbox_location";
  const source=await executeAiGateway({action:"inspect_registered_asset",brandSlug:plan.brandSlug,assetId:asset.id});
  if(source.registrationVerified!==true)throw new Error("Verification pending");
  const enrichment=await enrichAfterRegistrationIfEnabled(plan.brandSlug,asset.id);
  return {ok:true,registered:true,assetId:asset.id,brandSlug:plan.brandSlug,dropboxFileId:actual.id,dropboxPath:path,
   ...(enrichment.attempted?{autoEnrichment:enrichment}:{}),
   alreadyRegistered:data.alreadyRegistered===true,metadata:plan.metadata,
   note:"Dropbox source and global asset identity verified. Metadata saved; no publishing or S3 transfer. Existing workflow state preserved."};
 }catch{
  return verificationFailed({brandSlug:plan.brandSlug,dropboxFileId:actual.id,dropboxPath:path},
   asset.id,step);
 }
}

type Portal={version:1;kind:"portal";provider:string;brandSlug:string;filename:string;folder:string;
 metadata:ReturnType<typeof normalizedMetadata>;expiresAt:number};
async function unseal(value:unknown):Promise<Obj>{
 if(typeof value!=="string"||value.length>16000)throw new GatewayError(400,"Invalid upload capability");
 const dot=value.lastIndexOf("."),body=value.slice(0,dot);
 const actual=Buffer.from(value.slice(dot+1)),expected=Buffer.from(await signature(body));
 if(dot<1||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new GatewayError(403,"Invalid upload capability signature");
 let plan:Obj;try{plan=obj(JSON.parse(Buffer.from(body,"base64url").toString()));}catch{throw new GatewayError(400,"Invalid upload capability");}
 if(typeof plan.expiresAt!=="number"||!Number.isFinite(plan.expiresAt)||plan.expiresAt<=Date.now())
  throw new GatewayError(403,"Upload link expired; ask Claude for a new one");
 return plan;
}
export async function prepareClaudeUploadPage(args:unknown,identity:McpIdentity){
 const command=obj(args);allowed(identity,command);
 const slug=String(command.brandSlug),folder=String(command.folder||""),filename=safeFilename(command.filename);
 if(!insideBrand(slug,folder)||!/^(image|video)\//.test(mediaType(filename)))
  throw new GatewayError(400,"Choose an existing brand folder and an image/video filename");
 await executeAiGateway({action:"list_folders",scope:"brand",brandSlug:slug,path:folder});
 const plan:Portal={version:1,kind:"portal",provider:identity.clientId,brandSlug:slug,folder,filename,
  metadata:normalizedMetadata(command.metadata,filename),expiresAt:Date.now()+30*60*1000};
 const capability=await seal(plan);
 return {ok:true,uploadPage:"https://develop.d2k28tehm1a8zw.amplifyapp.com/epe-upload#"+capability,
  brandSlug:slug,folder,filename,metadata:plan.metadata,expiresInMinutes:30,uploadRequired:true,
  instruction:"Open this private upload link and select the file. The page uploads directly to Dropbox and completes EPE registration. Do not share the link. No file has been transferred yet."};
}
export async function handleClaudeUploadPage(args:unknown){
 const command=obj(args),portal=obj(await unseal(command.portalToken));
 if(portal.version!==1||portal.kind!=="portal"||!["claude_code","claude_web"].includes(String(portal.provider))||
  !insideBrand(String(portal.brandSlug),String(portal.folder)))throw new GatewayError(403,"Invalid upload page capability");
 const identity:McpIdentity={clientId:String(portal.provider),brandSlugs:[String(portal.brandSlug)],permissions:["assets:upload","assets:write"]};
 if(command.action==="preview")return {ok:true,filename:portal.filename,folder:portal.folder,metadata:portal.metadata,maxBytes:20*1024*1024};
 if(command.action==="prepare")return prepareClaudeTransfer({brandSlug:portal.brandSlug,filename:portal.filename,
  folder:portal.folder,metadata:portal.metadata,size:command.size,contentHash:command.contentHash,confirmed:true},identity);
 const transfer=await open(command.transferToken,identity,portal.brandSlug);
 if(transfer.filename!==portal.filename||JSON.stringify(transfer.metadata)!==JSON.stringify(portal.metadata))
  throw new GatewayError(403,"Transfer does not match the approved upload page");
 if(command.action==="complete")return completeClaudeTransfer({brandSlug:portal.brandSlug,transferToken:command.transferToken,confirmed:true},identity);
 if(command.action!=="chunk")throw new GatewayError(400,"Unsupported upload page action");
 const encoded=command.chunkBase64;
 if(typeof encoded!=="string"||encoded.length>Math.ceil(2*1024*1024/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
  throw new GatewayError(400,"Invalid upload chunk");
 const bytes=Buffer.from(encoded,"base64");
 if(!bytes.length||bytes.length>2*1024*1024||bytes.toString("base64")!==encoded)throw new GatewayError(400,"Invalid upload chunk encoding");
 let cursor:{sessionId:string;offset:number}|undefined;
 const transferDigest=createHmac("sha256","cursor-binding").update(String(command.transferToken)).digest("hex");
 if(command.cursorToken){
  const state=await unseal(command.cursorToken);
  if(state.kind!=="cursor"||state.transferDigest!==transferDigest||typeof state.sessionId!=="string"||
   typeof state.offset!=="number"||!Number.isSafeInteger(state.offset)||state.offset<1)throw new GatewayError(403,"Invalid chunk cursor");
  cursor={sessionId:state.sessionId,offset:state.offset};
 }
 const offset=cursor?.offset||0;
 if(offset+bytes.length>transfer.size)throw new GatewayError(400,"Chunk exceeds approved file size");
 const token=await dropboxToken();
 async function content(endpoint:string,arg:Obj,chunk:Buffer){
  const response=await fetch("https://content.dropboxapi.com/2/files/upload_session/"+endpoint,{
   method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/octet-stream","dropbox-api-arg":JSON.stringify(arg)},
   body:new Uint8Array(chunk),cache:"no-store",signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new GatewayError(409,"Dropbox chunk response unavailable/conflicted. Inspect completion before starting another upload.");
  const text=await response.text();return text?obj(JSON.parse(text)):{};
 }
 const final=offset+bytes.length===transfer.size;
 if(!cursor){
  const started=await content("start",{close:false},bytes);
  if(typeof started.session_id!=="string")throw new GatewayError(502,"Dropbox upload session missing");
  cursor={sessionId:started.session_id,offset:bytes.length};
  if(final)await content("finish",{cursor:{session_id:cursor.sessionId,offset:cursor.offset},commit:{path:transfer.path,mode:"add",autorename:false,mute:false,strict_conflict:true}},Buffer.alloc(0));
 }else if(final){
  await content("finish",{cursor:{session_id:cursor.sessionId,offset},commit:{path:transfer.path,mode:"add",autorename:false,mute:false,strict_conflict:true}},bytes);
 }else{
  await content("append_v2",{cursor:{session_id:cursor.sessionId,offset},close:false},bytes);
  cursor.offset+=bytes.length;
 }
 if(final)return {ok:true,complete:true,offset:transfer.size};
 const cursorToken=await seal({kind:"cursor",transferDigest,sessionId:cursor.sessionId,offset:cursor.offset,expiresAt:transfer.expiresAt});
 return {ok:true,complete:false,offset:cursor.offset,cursorToken};
}
