import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { authenticated } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const secrets=new SecretsManagerClient({region:"us-east-1"});
export async function POST(request:NextRequest) {
  if(!(await authenticated()))return NextResponse.json({error:"Login required"},{status:401});
  if(request.headers.get("origin")!=="https://develop.d2k28tehm1a8zw.amplifyapp.com")return NextResponse.json({error:"Invalid origin"},{status:403});
  const body=await request.json().catch(()=>null) as {brand?:string;folder?:string;names?:string[]}|null;
  const config=brandConfigs.find(b=>b.id===body?.brand);
  const folder=String(body?.folder||"").replace(/\\/g,"/").replace(/\/+$/,"");
  if(!config || !folder.toLowerCase().startsWith(config.dropboxRoot.toLowerCase()+"/") || folder.includes(".."))
    return NextResponse.json({error:"Invalid destination"},{status:400});
  const names=body?.names;
  if(!Array.isArray(names)||names.length<1||names.length>150||names.some(n=>typeof n!=="string"||!n||n.length>180||/[\/\\\x00-\x1f]/.test(n)||n==="."||n===".."))
    return NextResponse.json({error:"Invalid filenames"},{status:400});
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
    const results: {name:string;exists:boolean;size?:number;contentHash?:string;path?:string}[]=[];
    for(const name of names){
      const lookup=await fetch("https://api.dropboxapi.com/2/files/get_metadata",{method:"POST",
        headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
        body:JSON.stringify({path:folder+"/"+name}),cache:"no-store"});
      if(lookup.status===409){
        const data=await lookup.json().catch(()=>({})) as {error?:{".tag"?:string;path?:{".tag"?:string}}};
        if(data.error?.[".tag"]==="path"&&data.error.path?.[".tag"]==="not_found") {
          results.push({name,exists:false});continue;
        }
      }
      if(!lookup.ok)throw Error("Dropbox metadata lookup failed for "+name+" (HTTP "+lookup.status+")");
      const data=await lookup.json() as {".tag":string;size?:number;content_hash?:string;path_display?:string};
      if(data[".tag"]!=="file")throw Error("Destination is not a file: "+name);
      results.push({name,exists:true,size:data.size,contentHash:data.content_hash,path:data.path_display});
    }
    return NextResponse.json({results},{headers:{"cache-control":"no-store"}});
  }catch(error){
    console.error("Dropbox duplicate precheck failed:",error instanceof Error?error.name:"unknown");
    return NextResponse.json({error:"Unable to verify existing Dropbox files. Upload stopped to avoid duplicate transfers."},{status:503});
  }
}
