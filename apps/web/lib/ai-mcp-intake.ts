import {createHmac,randomBytes,timingSafeEqual} from "node:crypto";
import {serverSetting} from "@/lib/cognito-auth";
import {brandConfigs} from "@/lib/brand-config";
import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";
import type {McpIdentity} from "@/lib/ai-mcp-auth";

type Dict=Record<string,unknown>;
export type ChatFile={
 download_url:string;file_id:string;file_name?:string;mime_type?:string;
};
export type IntakeMetadata={
 title:string;topic?:string;contentGroup?:string;creativeFamily?:string;
 creativeNotes?:string;tags:string[];priority:"low"|"normal"|"high"
};
export type IntakePlan={
 version:1;provider:string;brandSlug:string;fileId:string;filename:string;
 mimeType:string;folder:string;metadata:IntakeMetadata;issuedAt:number;expiresAt:number;
 nonce:string
};

function inputRecord(value:unknown):Dict{
 if(!value||typeof value!=="object"||Array.isArray(value))
  throw new GatewayError(400,"Expected intake tool arguments");
 return value as Dict;
}
export function validChatFile(value:unknown):ChatFile{
 const obj=inputRecord(value);
 const fileId=obj.file_id, url=obj.download_url;
 if(typeof fileId!=="string"||!/^file_[A-Za-z0-9_-]{5,150}$/.test(fileId)||
  typeof url!=="string"||!url.startsWith("https://")||url.length>6000)
  throw new GatewayError(400,"Use a ChatGPT-authorized file input");
 if(obj.file_name!==undefined&&(typeof obj.file_name!=="string"||obj.file_name.length>180))
  throw new GatewayError(400,"Invalid source filename");
 if(obj.mime_type!==undefined&&(typeof obj.mime_type!=="string"||obj.mime_type.length>100))
  throw new GatewayError(400,"Invalid source MIME type");
 return obj as ChatFile;
}
export function safeFilename(name:unknown):string{
 if(typeof name!=="string"||!name||name.length>180||
  name==="."||name===".."||/[\/\\\x00-\x1f]/.test(name))
  throw new GatewayError(400,"Invalid filename; provide a simple name with an extension");
 return name;
}
const MEDIA_EXTENSIONS:Record<string,string>={
 ".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",
 ".webp":"image/webp",".gif":"image/gif",".heic":"image/heic",
 ".mp4":"video/mp4",".mov":"video/quicktime",".m4v":"video/x-m4v",
 ".webm":"video/webm",".mp3":"audio/mpeg",".wav":"audio/wav",
 ".m4a":"audio/mp4",".flac":"audio/flac"
};
export function mediaType(name:string){
 const ext=/\.[a-z0-9]+$/i.exec(name)?.[0].toLowerCase()||"";
 const value=MEDIA_EXTENSIONS[ext];
 if(!value)throw new GatewayError(400,"Unsupported media type: preview accepts common images, video, and audio");
 return value;
}
function normalizedMetadata(value:unknown,name:string):IntakeMetadata{
 const metadata=value===undefined?{}:inputRecord(value);
 const allowed=new Set(["title","topic","contentGroup","creativeFamily","creativeNotes","tags","priority"]);
 if(Object.keys(metadata).some(key=>!allowed.has(key)))
  throw new GatewayError(400,"Unsupported metadata field; use title/topic/contentGroup/creativeFamily/creativeNotes/tags/priority");
 const cleaned=name.replace(/\.[^.]+$/,"").replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
 const result:IntakeMetadata={title:typeof metadata.title==="string"&&metadata.title.trim()?metadata.title.trim():cleaned,
  tags:[],priority:"normal"};
 for(const field of ["topic","contentGroup","creativeFamily","creativeNotes"] as const){
  if(metadata[field]!==undefined&&metadata[field]!==null){
   if(typeof metadata[field]!=="string"||metadata[field].length>1500)
    throw new GatewayError(400,"Invalid "+field);
   if(metadata[field].trim())result[field]=metadata[field].trim();
  }
 }
 if(result.title.length>180||!result.title)throw new GatewayError(400,"Invalid asset title");
 if(metadata.priority!==undefined){
  if(!["low","normal","high"].includes(String(metadata.priority)))
   throw new GatewayError(400,"Invalid priority");
  result.priority=metadata.priority as IntakeMetadata["priority"];
 }
 const words=cleaned.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=3&&w.length<=35);
 const source=metadata.tags===undefined?words.slice(0,8):metadata.tags;
 if(!Array.isArray(source)||source.length>50||
  source.some(t=>typeof t!=="string"||!t.trim()||t.length>100))
  throw new GatewayError(400,"Invalid tags");
 result.tags=[...new Set(source.map(tag=>(tag as string).trim()))];
 if(result.tags.join(", ").length>500)throw new GatewayError(400,"Too many tags");
 return result;
}
export function insideBrand(slug:string,path:string):boolean{
 const root=brandConfigs.find(item=>item.id===slug)?.dropboxRoot;
 if(!root||typeof path!=="string"||path.length>2048||
   /[\\\x00-\x1f]/.test(path)||
   path.split("/").some((part,i)=>i>0&&(!part||part==="."||part==="..")))
  return false;
 return path.toLowerCase().startsWith(root.toLowerCase()+"/");
}
async function verifyExistingFolder(slug:string,folder:string){
 if(!insideBrand(slug,folder))throw new GatewayError(403,"Outside selected brand's Dropbox folders");
 const result=await executeAiGateway({action:"list_folders",scope:"brand",brandSlug:slug,path:folder});
 if(result.ok!==true)throw new GatewayError(502,"Cannot verify Dropbox destination");
}
function scoreFolder(name:string,filename:string,mime:string):number{
 const folder=name.toLowerCase(),filenameLower=filename.toLowerCase();
 const kind=mime.split("/")[0];
 let score=0;
 if((kind==="image"&&/^(images?|graphics?|photos?)$/.test(folder))||
   (kind==="video"&&/^(videos?|clips?|shorts?)$/.test(folder))||
   (kind==="audio"&&/^(audio|music|songs?|podcasts?)$/.test(folder)))score+=10;
 if(/radio/.test(filenameLower)&&/radio/.test(folder))score+=6;
 if(/stashbox|band|concert|gig|dylan|sublime/.test(filenameLower)&&/band/.test(folder))score+=5;
 if(filenameLower.includes(folder)&&folder.length>2)score+=5;
 if(/shared/.test(folder))score-=1;
 return score;
}
async function sign(value:string){
 const secret=await serverSetting("ELETTRO_AUTH_SESSION_SECRET");
 if(secret.length<32)throw new GatewayError(503,"Intake signing secret unavailable");
 return createHmac("sha256",secret).update(value).digest("base64url");
}
export async function sealIntakePlan(plan:IntakePlan){
 const body=Buffer.from(JSON.stringify(plan)).toString("base64url");
 return body+"."+(await sign(body));
}
export async function verifyIntakePlan(token:unknown,identity:McpIdentity,file:ChatFile):Promise<IntakePlan>{
 if(typeof token!=="string"||token.length>8000||!token.includes("."))
  throw new GatewayError(400,"Missing signed intake preview");
 const dot=token.lastIndexOf(".");
 const body=token.slice(0,dot),provided=Buffer.from(token.slice(dot+1));
 const expected=Buffer.from(await sign(body));
 if(!expected.length||provided.length!==expected.length||!timingSafeEqual(provided,expected))
  throw new GatewayError(403,"Intake preview signature invalid; prepare it again");
 let plan:IntakePlan;
 try{plan=JSON.parse(Buffer.from(body,"base64url").toString("utf8")) as IntakePlan;}
 catch{throw new GatewayError(400,"Intake preview could not be read");}
 if(plan.version!==1||plan.provider!==identity.clientId||
   !identity.brandSlugs.includes(plan.brandSlug)||
   plan.fileId!==file.file_id||!insideBrand(plan.brandSlug,plan.folder)||
   !Number.isFinite(plan.expiresAt)||plan.expiresAt<=Date.now()||
   !Number.isFinite(plan.issuedAt)||plan.issuedAt>Date.now()+60000||
   plan.expiresAt-plan.issuedAt>20*60*1000||
   safeFilename(plan.filename)!==plan.filename)
  throw new GatewayError(403,"Intake preview expired or changed; prepare it again");
 return plan;
}
export async function prepareChatFileIntake(args:unknown,identity:McpIdentity){
 const obj=inputRecord(args),file=validChatFile(obj.file);
 const slug=String(obj.brandSlug||"");
 const config=brandConfigs.find(item=>item.id===slug);
 if(!config||!identity.brandSlugs.includes(slug))
  throw new GatewayError(403,"Brand not authorized");
 const filename=safeFilename(file.file_name||obj.filename);
 const mime=mediaType(filename);
 const draft=normalizedMetadata(obj.metadata,filename);
 if(file.mime_type&&file.mime_type.split(";")[0].toLowerCase()!==mime){
  // MIME aliases vary; alert instead of trusting the MIME for file type.
  if(file.mime_type.toLowerCase()!== "application/octet-stream")
   throw new GatewayError(400,"Source MIME type and filename extension differ");
 }
 const folderResult=await executeAiGateway({action:"list_folders",scope:"brand",brandSlug:slug,path:config.dropboxRoot});
 const rootFolders=Array.isArray(folderResult.folders)
  ?folderResult.folders as Array<{id?:string;name?:string;path?:string}>:[];
 const candidates=rootFolders
  .filter(v=>typeof v.name==="string"&&typeof v.path==="string"&&insideBrand(slug,v.path))
  .map(v=>({name:String(v.name),path:String(v.path),
    score:scoreFolder(String(v.name),filename,mime)}))
  .sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path))
  .slice(0,10);
 const preferred=typeof obj.folder==="string"&&obj.folder.trim()?obj.folder.trim():undefined;
 // Never write into root or silently create folders. A user/model-specified
 // destination must exist and pass brand-scoped server verification.
 const folder=preferred || (candidates[0]?.score>=5?candidates[0].path:undefined);
 if(!folder)return {ok:true,brandSlug:slug,filename,mimeType:mime,
   metadata:draft,needsFolderSelection:true,folderCandidates:candidates,
   note:"Choose an existing folder or create one with separately confirmed folder-write permission. No Dropbox upload occurred."};
 await verifyExistingFolder(slug,folder);
 const now=Date.now();
 const plan:IntakePlan={version:1,provider:identity.clientId,brandSlug:slug,
  fileId:file.file_id,filename,mimeType:mime,folder,metadata:draft,
  issuedAt:now,expiresAt:now+15*60*1000,nonce:randomBytes(12).toString("base64url")};
 const planToken=await sealIntakePlan(plan);
 return {ok:true,brandSlug:slug,filename,mimeType:mime,folder,metadata:draft,
   needsConfirmation:true,readOnly:true,planToken,
   expiresInMinutes:15,folderCandidates:candidates,
   note:"Review the exact folder and tags. To upload, explicitly confirm and call the separate upload tool with this signed plan and the same authorized file. No file was transferred."};
}
