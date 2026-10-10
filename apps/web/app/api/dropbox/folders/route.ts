import { NextRequest, NextResponse } from "next/server";
import { brandConfigs } from "@/lib/brand-config";
export const dynamic = "force-dynamic";
const apiBase = process.env.BRAND_OS_API_BASE_URL || process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL || "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
export async function GET(request:NextRequest){
 const brand=request.nextUrl.searchParams.get("brand")||"";
 const config=brandConfigs.find(item=>item.id===brand);
 if(!config)return NextResponse.json({error:"Unknown brand"},{status:400});
 const root=config.dropboxRoot;
 const path=request.nextUrl.searchParams.get("path")||root;
 const normalized=path.replace(/\\/g,"/").replace(/\/+$/,"");
 if(normalized.toLowerCase()!==root.toLowerCase()&&!normalized.toLowerCase().startsWith(root.toLowerCase()+"/"))
  return NextResponse.json({error:"Outside brand root"},{status:403});
 const endpoint=new URL(apiBase.replace(/\/+$/,"")+"/dropbox/folders");
 endpoint.searchParams.set("brand",brand);endpoint.searchParams.set("path",normalized);
 try{
  const result=await fetch(endpoint.toString(),{cache:"no-store"});
  if(result.status===404||result.status===403)return NextResponse.json({error:"DEV API Dropbox folder-listing route is not deployed or authorized yet."},{status:503});
  const raw=await result.text();
  let data:unknown;
  try{data=JSON.parse(raw)}catch{return NextResponse.json({error:"DEV API returned a non-JSON folder listing response."},{status:502});}
  return NextResponse.json(data,{status:result.status,headers:{"cache-control":"no-store"}});
 }catch{return NextResponse.json({error:"Cannot reach the DEV API folder-listing endpoint."},{status:503});}
}
