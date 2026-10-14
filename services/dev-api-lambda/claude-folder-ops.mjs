import {SecretsManagerClient,GetSecretValueCommand} from "@aws-sdk/client-secrets-manager";
const secrets=new SecretsManagerClient({region:"us-east-1"});
const BRANDS=new Set(["stashbox","elettro","solarmeister","weightlossdavie","neckermann-strom","therasbox"]);
function pathInBrand(value,root,allowRoot=false){
 if(typeof value!=="string"||value.length>2048||/[\\\x00-\x1f]/.test(value))throw new Error("Invalid folder path");
 const path=value.replace(/\/+$/,"");
 if(path.split("/").some((v,i)=>i>0&&(!v||v==="."||v==="..")))throw new Error("Unsafe folder path");
 if(!(allowRoot&&path.toLowerCase()===root.toLowerCase())&&!path.toLowerCase().startsWith(root.toLowerCase()+"/"))
  throw new Error("Folder outside brand, or brand root cannot be moved");
 return path;
}
async function accessToken(){
 const result=await secrets.send(new GetSecretValueCommand({SecretId:process.env.DROPBOX_SECRET_NAME||"elettro-brand-os-dev/dropbox"}));
 const c=JSON.parse(result.SecretString||"{}");
 const refresh=c.refresh_token||c.refreshToken,key=c.app_key||c.appKey,password=c.app_secret||c.appSecret;
 if(!refresh||!key||!password)throw new Error("Dropbox credentials unavailable");
 const r=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",body:new URLSearchParams({
  grant_type:"refresh_token",refresh_token:refresh,client_id:key,client_secret:password}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error("Dropbox authorization failed");
 const token=(await r.json()).access_token;if(!token)throw new Error("Dropbox token missing");return token;
}
async function call(token,endpoint,body){
 const r=await fetch("https://api.dropboxapi.com/2/files/"+endpoint,{method:"POST",
  headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw new Error(r.status===409?"Dropbox folder missing or destination conflicts":"Dropbox folder operation failed");
 return r.json();
}
function relocate(value,from,to){
 return typeof value==="string"&&value.toLowerCase().startsWith(from.toLowerCase()+"/")?to+value.slice(from.length):value;
}
export async function moveBrandFolder(body,connectDatabase,json){
 let client,folderId,source,target,moved=false,commitStarted=false;
 try{
  if(body.confirmed!==true||!BRANDS.has(body.brandSlug))return json(400,{ok:false,error:"Confirmed brand folder operation required"});
  const root="/1---elettro-brand-os/"+body.brandSlug;
  source=pathInBrand(body.path,root);
  const parent=body.operation==="rename"?source.slice(0,source.lastIndexOf("/")):pathInBrand(body.parentPath,root,true);
  const name=body.operation==="rename"?body.name:source.slice(source.lastIndexOf("/")+1);
  if(!["rename","move"].includes(body.operation)||typeof name!=="string"||!name.trim()||name.length>180||
   /[\/\\\x00-\x1f]/.test(name)||name==="."||name==="..")return json(400,{ok:false,error:"Invalid folder operation/name"});
  target=pathInBrand(parent+"/"+name,root);
  if(target.toLowerCase()===source.toLowerCase()||parent.toLowerCase()===source.toLowerCase()||
   parent.toLowerCase().startsWith(source.toLowerCase()+"/"))return json(400,{ok:false,error:"Self and descendant moves are blocked"});
  client=await connectDatabase();await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["epe-folder:"+body.brandSlug]);
  const brand=await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1 AND "status"=$2',[body.brandSlug,"active"]);
  if(!brand.rows[0])throw new Error("Active brand not found");
  const token=await accessToken();
  const folder=await call(token,"get_metadata",{path:source});
  if(folder[".tag"]!=="folder"||!folder.id)throw new Error("Source must be an existing folder");
  folderId=folder.id;source=pathInBrand(folder.path_display,root);
  const destination=await call(token,"get_metadata",{path:parent});
  if(destination[".tag"]!=="folder")throw new Error("Destination parent must be an existing folder");
  const files=new Map();let cursor,pages=0;
  do{
   if(++pages>20)throw new Error("Folder inventory too large for this operation; use the dashboard");
   const page=await call(token,cursor?"list_folder/continue":"list_folder",cursor?{cursor}:{path:source,recursive:true,include_deleted:false,limit:2000});
   for(const entry of page.entries||[])if(entry[".tag"]==="file"&&entry.id&&entry.path_display?.toLowerCase().startsWith(source.toLowerCase()+"/"))files.set(entry.id,entry.path_display);
   cursor=page.has_more?page.cursor:undefined;
  }while(cursor);
  const selected=await client.query(`SELECT "id","brandId","sourceFileId","sourceExternalId","sourcePath","sourcePathLower","sourceUrl","sourceMetadata"
   FROM "Asset" WHERE "sourceType"='dropbox' AND
    ("sourceFileId"=ANY($4::text[]) OR "sourceExternalId"=ANY($4::text[]) OR
     ("brandId"=$1 AND (left(lower(coalesce("sourcePath",'')),$2)=$3 OR left(lower(coalesce("sourceUrl",'')),$2)=$3))) FOR UPDATE`,
   [brand.rows[0].id,source.length+1,source.toLowerCase()+"/",[...files.keys()]]);
  const currentPaths=new Map(),seenIds=new Set();
  for(const asset of selected.rows){
   if(asset.brandId!==brand.rows[0].id)throw new Error("A folder file is registered under another brand; move stopped");
   const ids=[asset.sourceFileId,asset.sourceExternalId].filter(v=>v!==null&&v!==undefined&&v!=="");
   if(!ids.length||ids.some(v=>typeof v!=="string"||!v.startsWith("id:"))||new Set(ids).size!==1)throw new Error("An affected asset lacks a consistent Dropbox ID; move stopped");
   if(seenIds.has(ids[0]))throw new Error("A folder file has duplicate registered assets; move stopped");
   seenIds.add(ids[0]);
   const currentPath=files.get(ids[0]);
   if(!currentPath)throw new Error("An affected asset is absent from the folder inventory; reconcile before moving");
   currentPaths.set(asset.id,currentPath);
  }
  const result=await call(token,"move_v2",{from_path:folderId,to_path:target,autorename:false,allow_shared_folder:false,allow_ownership_transfer:false});
  moved=true;
  if(result.metadata?.id!==folderId||!result.metadata.path_display)throw new Error("Moved folder identity not verified");
  target=pathInBrand(result.metadata.path_display,root);
  for(const asset of selected.rows){
   const newPath=relocate(currentPaths.get(asset.id),source,target);
   const data=asset.sourceMetadata&&typeof asset.sourceMetadata==="object"?{...asset.sourceMetadata}:{};
   for(const key of ["path","path_display","path_lower"])if(typeof data[key]==="string")data[key]=key==="path_lower"?newPath.toLowerCase():newPath;
   await client.query(`UPDATE "Asset" SET "sourcePath"=$2,"sourcePathLower"=$3,"sourceUrl"=$4,"sourceMetadata"=$5::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
    [asset.id,typeof asset.sourcePath==="string"?newPath:null,typeof asset.sourcePathLower==="string"?newPath.toLowerCase():null,
     typeof asset.sourceUrl==="string"&&asset.sourceUrl.startsWith("/")?newPath:asset.sourceUrl,JSON.stringify(data)]);
  }
  commitStarted=true;await client.query("COMMIT");
  return json(200,{ok:true,dropboxFolderId:folderId,previousPath:source,path:target,assetsSynchronized:selected.rows.length,
   note:"Folder ID and file IDs preserved; asset workflow statuses unchanged"});
 }catch(error){
  if(client)await client.query("ROLLBACK").catch(()=>{});
  let restored=false;
  // A lost COMMIT response is ambiguous. Do not compensate in that case.
  if(moved&&!commitStarted){try{const r=await call(await accessToken(),"move_v2",{from_path:folderId,to_path:source,autorename:false,allow_shared_folder:false,allow_ownership_transfer:false});restored=r.metadata?.id===folderId;}catch{}}
  return json(moved&&!restored?200:409,{ok:false,reconciliationRequired:moved&&!restored,moveRolledBack:restored,
   ...(folderId?{dropboxFolderId:folderId,previousPath:source,destinationPath:target}:{}),
   error:error instanceof Error?error.message:"Folder operation failed",
   ...(moved&&!restored?{message:"Dropbox may have moved the folder. Do not retry the move; reconcile this folder ID and registered paths."}:{})});
 }finally{if(client)await client.end().catch(()=>{});}
}
export async function repairClaudeTestStatus(connectDatabase,json){
 let client;
 try{
  client=await connectDatabase();await client.query("BEGIN");
  const result=await client.query(`SELECT a."id",a."title",a."tags",a."ingestStatus",a."approvalStatus",b."slug" FROM "Asset" a
   JOIN "Brand" b ON b."id"=a."brandId" WHERE a."id"=$1 FOR UPDATE OF a`,["01e25531-b43c-478f-93fa-9a9f65a2ee89"]);
  const asset=result.rows[0];
  if(!asset||asset.slug!=="elettro"||asset.title!=null||asset.approvalStatus!=="approved"||
   !Array.isArray(asset.tags)||asset.tags.length||!["raw","needs_metadata"].includes(asset.ingestStatus))
   throw new Error("Test asset no longer matches the recorded state; repair stopped");
  const changed=asset.ingestStatus!=="raw";
  if(changed)await client.query('UPDATE "Asset" SET "ingestStatus"=$2::"IngestStatus","updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',[asset.id,"raw"]);
  await client.query("COMMIT");return json(200,{ok:true,assetId:asset.id,ingestStatus:"raw",changed,
   note:"Only the documented ingestStatus side effect was repaired; enrichmentStatus was not guessed"});
 }catch(error){if(client)await client.query("ROLLBACK").catch(()=>{});return json(409,{ok:false,error:error.message});}
 finally{if(client)await client.end().catch(()=>{});}
}
