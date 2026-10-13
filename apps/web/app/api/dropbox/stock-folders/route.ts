import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { authenticated } from "@/lib/cognito-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ROOT = "/1---elettro-brand-os/creative-assets";
const secrets = new SecretsManagerClient({region:"us-east-1"});

export async function GET(request:NextRequest) {
  if (!(await authenticated())) return NextResponse.json({error:"Login required"},{status:401});
  const path = (request.nextUrl.searchParams.get("path") || ROOT).replace(/\\/g,"/").replace(/\/+$/,"");
  if (path.toLowerCase()!==ROOT.toLowerCase() && !path.toLowerCase().startsWith(ROOT.toLowerCase()+"/"))
    return NextResponse.json({error:"Outside shared stock root"},{status:403});
  try {
    const secret = await secrets.send(new GetSecretValueCommand({SecretId:"elettro-brand-os-dev/dropbox"}));
    const data=JSON.parse(secret.SecretString||"{}") as Record<string,string>;
    const refresh=data.refresh_token||data.refreshToken;
    const key=data.app_key||data.appKey;
    const appSecret=data.app_secret||data.appSecret;
    if (!refresh||!key||!appSecret) throw new Error("Dropbox credentials unavailable");
    const auth=await fetch("https://api.dropboxapi.com/oauth2/token",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,client_id:key,client_secret:appSecret}),cache:"no-store"
    });
    if(!auth.ok) throw new Error("Dropbox authorization failed");
    const token=(await auth.json() as {access_token:string}).access_token;
    const folders:Array<{id?:string;name:string;path:string}>=[];
    let cursor:string|undefined;
    do {
      const response=await fetch("https://api.dropboxapi.com/2/files/"+(cursor?"list_folder/continue":"list_folder"),{
        method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
        body:JSON.stringify(cursor?{cursor}:{path,recursive:false,include_deleted:false,limit:200}),cache:"no-store"
      });
      if(!response.ok) {
        if(response.status===409) return NextResponse.json({error:"Shared stock folder does not exist in Dropbox yet",details:"Create /1---elettro-brand-os/creative-assets with stock-graphics and stock-videos beneath it."},{status:404});
        throw new Error("Dropbox folder listing failed");
      }
      const page=await response.json() as {entries:Array<{".tag":string;id?:string;name:string;path_display?:string}>;cursor:string;has_more:boolean};
      for (const entry of page.entries) if(entry[".tag"]==="folder" && entry.path_display)
        folders.push({id:entry.id,name:entry.name,path:entry.path_display});
      cursor=page.has_more?page.cursor:undefined;
    } while(cursor);
    return NextResponse.json({root:ROOT,path,folders},{headers:{"cache-control":"no-store"}});
  } catch(error) {
    console.error("Stock folder listing failed",error instanceof Error?error.name:"Unknown");
    return NextResponse.json({error:"Unable to read shared stock folders"},{status:503});
  }
}
