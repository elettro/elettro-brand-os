import { connectKeyHeaders } from "@/lib/dev-api-key";
import { NextRequest, NextResponse } from "next/server";
import { brandConfigs } from "@/lib/brand-config";
import { authenticated, allowedOrigin } from "@/lib/cognito-auth";
export const dynamic = "force-dynamic";
const API_BASE = process.env.BRAND_OS_API_BASE_URL || process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL || "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
const secrets = new SecretsManagerClient({region:"us-east-1"});

// List Dropbox directly at the selected brand root. Never delegate navigation
// to an upstream handler that might resolve another brand or the global root.
export async function GET(request:NextRequest){
 if(!(await authenticated()))return NextResponse.json({error:"Login required"},{status:401});
 const brand=request.nextUrl.searchParams.get("brand")||"";
 const config=brandConfigs.find(item=>item.id===brand);
 if(!config)return NextResponse.json({error:"Unknown brand"},{status:400});
 const root=config.dropboxRoot;
 const normalized=(request.nextUrl.searchParams.get("path")||root).replace(/\\/g,"/").replace(/\/+$/,"");
 if(normalized.toLowerCase()!==root.toLowerCase()&&!normalized.toLowerCase().startsWith(root.toLowerCase()+"/"))
  return NextResponse.json({error:"Outside brand root"},{status:403});
 try {
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:"elettro-brand-os-dev/dropbox"}));
  const cfg=JSON.parse(secret.SecretString||"{}") as Record<string,string>;
  const refresh=cfg.refresh_token||cfg.refreshToken;
  const key=cfg.app_key||cfg.appKey;
  const appSecret=cfg.app_secret||cfg.appSecret;
  if(!refresh||!key||!appSecret)throw Error("Dropbox credentials unavailable");
  const auth=await fetch("https://api.dropboxapi.com/oauth2/token",{
   method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,client_id:key,client_secret:appSecret}),cache:"no-store"
  });
  if(!auth.ok)throw Error("Dropbox authorization failed");
  const token=(await auth.json() as {access_token:string}).access_token;
  const folders:Array<{id?:string;name:string;path:string}>=[];
  let cursor:string|undefined;
  do {
   const response=await fetch("https://api.dropboxapi.com/2/files/"+(cursor?"list_folder/continue":"list_folder"),{
    method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify(cursor?{cursor}:{path:normalized,recursive:false,include_deleted:false,limit:200}),cache:"no-store"
   });
   if(!response.ok)throw Error("Dropbox listing returned HTTP "+response.status);
   const page=await response.json() as {entries:Array<{".tag":string;id?:string;name:string;path_display?:string}>;cursor:string;has_more:boolean};
   for(const entry of page.entries){
    if(entry[".tag"]!=="folder"||!entry.path_display)continue;
    if(!entry.path_display.toLowerCase().startsWith(root.toLowerCase()+"/"))continue;
    folders.push({id:entry.id,name:entry.name,path:entry.path_display});
   }
   cursor=page.has_more?page.cursor:undefined;
  }while(cursor);
  return NextResponse.json({root,path:normalized,folders},{headers:{"cache-control":"no-store"}});
 }catch(error){
  console.error("Brand Dropbox listing failed",error instanceof Error?error.name:"Unknown");
  return NextResponse.json({error:"Unable to list brand Dropbox folders"},{status:503});
 }
}

// DEV-only folder creation; brand-root validated server-side as well as by Lambda.
export async function POST(request:NextRequest){
 if(!(await authenticated()))return NextResponse.json({error:"Login required"},{status:401});
 if(!allowedOrigin(request.headers.get("origin")))return NextResponse.json({error:"Invalid request origin"},{status:403});
 const body=await request.json().catch(()=>({})) as Record<string,unknown>;
 const brand=String(body.brand||"");
 const config=brandConfigs.find(item=>item.id===brand);
 if(!config)return NextResponse.json({error:"Unknown brand"},{status:400});
 const path=String(body.path||config.dropboxRoot).replace(/\\/g,"/").replace(/\/+$/,"");
 if(path.toLowerCase()!==config.dropboxRoot.toLowerCase()&&!path.toLowerCase().startsWith(config.dropboxRoot.toLowerCase()+"/"))return NextResponse.json({error:"Outside brand root"},{status:403});
 const name=String(body.name||"").trim();
 if(!name||name.length>180||/[\/\x00-\x1f]/.test(name)||name==="."||name==="..")return NextResponse.json({error:"Invalid folder name"},{status:400});
 try{
  const response=await fetch(`${API_BASE}/assets/bulk-update`,{method:"POST",headers:await connectKeyHeaders({"content-type":"application/json"}),body:JSON.stringify({action:"create-brand-folder",brand,path,name}),cache:"no-store"});
  const data=await response.json();
  return NextResponse.json(data,{status:response.status});
 }catch(error){return NextResponse.json({error:"Unable to create Dropbox folder",details:error instanceof Error?error.message:"Network error"},{status:503});}
}
