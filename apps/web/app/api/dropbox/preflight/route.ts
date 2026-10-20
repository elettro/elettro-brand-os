import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { authenticated, allowedOrigin } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const secrets=new SecretsManagerClient({region:"us-east-1"});
export async function POST(request:NextRequest) {
  if(!(await authenticated()))return NextResponse.json({error:"Login required"},{status:401});
  if(!allowedOrigin(request.headers.get("origin")))return NextResponse.json({error:"Invalid origin"},{status:403});
  const body=await request.json().catch(()=>null) as {brand?:string;folder?:string;names?:string[];files?:Array<{name:string;size:number;contentHash:string}>}|null;
  const config=brandConfigs.find(b=>b.id===body?.brand);
  const folder=String(body?.folder||"").replace(/\\/g,"/").replace(/\/+$/,"");
  if(!config || !folder.toLowerCase().startsWith(config.dropboxRoot.toLowerCase()+"/") || folder.includes(".."))
    return NextResponse.json({error:"Invalid destination"},{status:400});
  const names=body?.names;
  if(!Array.isArray(names)||names.length<1||names.length>150||names.some(n=>typeof n!=="string"||!n||n.length>180||/[\/\\\x00-\x1f]/.test(n)||n==="."||n===".."))
    return NextResponse.json({error:"Invalid filenames"},{status:400});
  if(!Array.isArray(body?.files)||body.files.length!==names.length||
    body.files.some((f,i)=>f.name!==names[i]||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/i.test(f.contentHash)))
    return NextResponse.json({error:"Invalid content fingerprint list"},{status:400});
  try{
    const response=await secrets.send(new GetSecretValueCommand({SecretId:"elettro-brand-os-dev/dropbox"}));
    const cfg=JSON.parse(response.SecretString||"{}") as Record<string,string>;
    const refresh=cfg.refresh_token||cfg.refreshToken;
    const key=cfg.app_key||cfg.appKey;
    const secret=cfg.app_secret||cfg.appSecret;
    if(!refresh||!key||!secret)throw Error("Dropbox credentials unavailable");
    const tokenResponse=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,client_id:key,client_secret:secret}),cache:"no-store"});
    if(!tokenResponse.ok)throw Error("Dropbox token unavailable");
    const token=(await tokenResponse.json() as {access_token:string}).access_token;
    const checkName=async(name:string):Promise<{name:string;exists:boolean;size?:number;contentHash?:string;path?:string}>=>{
      const lookup=await fetch("https://api.dropboxapi.com/2/files/get_metadata",{method:"POST",
        headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
        body:JSON.stringify({path:folder+"/"+name}),cache:"no-store"});
      if(lookup.status===409){
        const data=await lookup.json().catch(()=>({})) as {error?:{".tag"?:string;path?:{".tag"?:string}}};
        if(data.error?.[".tag"]==="path"&&data.error.path?.[".tag"]==="not_found")return {name,exists:false};
      }
      if(!lookup.ok)throw Error("Dropbox metadata lookup failed (HTTP "+lookup.status+")");
      const data=await lookup.json() as {".tag":string;size?:number;content_hash?:string;path_display?:string};
      if(data[".tag"]!=="file")throw Error("Destination is not a file");
      return {name,exists:true,size:data.size,contentHash:data.content_hash,path:data.path_display};
    };
    const results:Awaited<ReturnType<typeof checkName>>[]=[];
    // Bound concurrency to keep large batches fast without overwhelming Dropbox.
    for(let i=0;i<names.length;i+=8)results.push(...await Promise.all(names.slice(i,i+8).map(checkName)));
    // Scan the selected brand's entire Dropbox tree. Dropbox file IDs survive
    // renames/moves; content hashes identify exact bytes regardless of filename.
    // Fail closed if the scan cannot finish: never claim a partial scan is exhaustive.
    const byHash=new Map<string,{path:string;id:string;size:number}>();
    let cursor:string|undefined;
    let pages=0;
    do {
      if(++pages>200)throw Error("Brand inventory too large for an exhaustive preflight");
      const endpoint=cursor?"list_folder/continue":"list_folder";
      const scan=await fetch("https://api.dropboxapi.com/2/files/"+endpoint,{
        method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
        body:JSON.stringify(cursor?{cursor}:{path:config.dropboxRoot,recursive:true,include_deleted:false,limit:2000}),cache:"no-store"});
      if(!scan.ok)throw Error("Dropbox brand inventory unavailable (HTTP "+scan.status+")");
      const page=await scan.json() as {entries:Array<{".tag":string;id?:string;size?:number;content_hash?:string;path_display?:string}>;cursor:string;has_more:boolean};
      for(const entry of page.entries){
        if(entry[".tag"]!=="file"||!entry.content_hash||!entry.path_display||!entry.id||typeof entry.size!=="number")continue;
        const contentHash=entry.content_hash.toLowerCase();
        if(!byHash.has(contentHash))byHash.set(contentHash,{path:entry.path_display,id:entry.id,size:entry.size});
      }
      cursor=page.has_more?page.cursor:undefined;
    }while(cursor);
    const matches=(body?.files||[]).map(item=>{
      const match=byHash.get(String(item.contentHash||"").toLowerCase());
      return match&&match.size===item.size?{name:item.name,path:match.path,id:match.id}:null;
    });
    return NextResponse.json({results,matches},{headers:{"cache-control":"no-store"}});
  }catch(error){
    console.error("Dropbox duplicate precheck failed:",error instanceof Error?error.name:"unknown");
    return NextResponse.json({error:"Unable to verify existing Dropbox files. Upload stopped to avoid duplicate transfers."},{status:503});
  }
}
