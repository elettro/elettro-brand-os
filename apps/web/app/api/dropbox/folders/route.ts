import { NextRequest, NextResponse } from "next/server";
import { brandConfigs } from "@/lib/brand-config";
export const dynamic = "force-dynamic";
type DropboxEntry = { ".tag": string; id?: string; name: string; path_display?: string; path_lower?: string };
async function token():Promise<string> {
 const refresh=process.env.DROPBOX_REFRESH_TOKEN;
 const clientId=process.env.DROPBOX_CLIENT_ID;
 const clientSecret=process.env.DROPBOX_CLIENT_SECRET;
 if(refresh&&clientId&&clientSecret){
  const res=await fetch("https://api.dropbox.com/oauth2/token",{
   method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
   body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,client_id:clientId,client_secret:clientSecret}),
   cache:"no-store"
  });
  if(!res.ok)throw Error("Dropbox token refresh failed: "+res.status);
  const data=await res.json();return data.access_token;
 }
 if(process.env.DROPBOX_ACCESS_TOKEN)return process.env.DROPBOX_ACCESS_TOKEN;
 throw Error("Dropbox credentials are not configured for the web app.");
}
export async function GET(req:NextRequest){
 const brand=req.nextUrl.searchParams.get("brand")||"";
 const config=brandConfigs.find(b=>b.id===brand);
 if(!config)return NextResponse.json({error:"Unknown brand"},{status:400});
 const root=config.dropboxRoot;
 const target=req.nextUrl.searchParams.get("path")||root;
 // Normalize case-insensitive Dropbox path, enforce brand root so a user cannot browse another brand.
 const normalized=target.replace(/\\/g,"/").replace(/\/+$/,"");
 if(normalized.toLowerCase()!==root.toLowerCase()&&!normalized.toLowerCase().startsWith(root.toLowerCase()+"/"))
  return NextResponse.json({error:"Folder is outside this brand's Dropbox root"},{status:403});
 try{
  const accessToken=await token();
  const headers={Authorization:"Bearer "+accessToken,"Content-Type":"application/json"};
  const folders:DropboxEntry[]=[];
  let cursor:string|undefined;
  do {
   const url=cursor?"https://api.dropboxapi.com/2/files/list_folder/continue":"https://api.dropboxapi.com/2/files/list_folder";
   const response=await fetch(url,{method:"POST",headers,body:JSON.stringify(cursor?{cursor}:{path:normalized,recursive:false,include_deleted:false,limit:1000}),cache:"no-store"});
   const result=await response.json();
   if(!response.ok)return NextResponse.json({error:"Dropbox folder listing failed",details:result.error_summary||response.status},{status:502});
   folders.push(...(result.entries||[]).filter((entry:DropboxEntry)=>entry[".tag"]==="folder"));
   cursor=result.has_more?result.cursor:undefined;
  }while(cursor);
  return NextResponse.json({brand,root,path:normalized,folders:folders.map(entry=>({id:entry.id,name:entry.name,path:entry.path_display||entry.path_lower})).sort((a:{name:string},b:{name:string})=>a.name.localeCompare(b.name)),readOnly:true});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unable to list Dropbox folders"},{status:503});}
}
