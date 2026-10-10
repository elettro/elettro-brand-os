import { NextRequest, NextResponse } from "next/server";
import { brandConfigs } from "@/lib/brand-config";
export const dynamic = "force-dynamic";
const API_BASE = process.env.BRAND_OS_API_BASE_URL || process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL || "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
export async function GET(request:NextRequest){
 const brand=request.nextUrl.searchParams.get("brand")||"";
 const config=brandConfigs.find(item=>item.id===brand);
 if(!config)return NextResponse.json({error:"Unknown brand"},{status:400});
 const root=config.dropboxRoot;
 const path=request.nextUrl.searchParams.get("path")||root;
 const normalized=path.replace(/\\/g,"/").replace(/\/+$/,"");
 if(normalized.toLowerCase()!==root.toLowerCase()&&!normalized.toLowerCase().startsWith(root.toLowerCase()+"/"))
  return NextResponse.json({error:"Outside brand root"},{status:403});
 try{
  const response=await fetch(`${API_BASE.replace(/\\/+$/, "")}/assets/bulk-update`,{
   method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({action:"dropbox-list-folders",brand,path:normalized}),
   cache:"no-store"
  });
  const raw=await response.text();
  let data:Record<string,unknown>;
  try{data=JSON.parse(raw)}catch{return NextResponse.json({error:"DEV API returned a non-JSON response"},{status:502});}
  if(!response.ok||data.ok===false)return NextResponse.json({error:String(data.error||"Dropbox folder listing failed")},{status:response.status});
  return NextResponse.json(data,{headers:{"cache-control":"no-store"}});
 }catch(error){return NextResponse.json({error:"Unable to reach DEV API Gateway",details:error instanceof Error?error.message:"Network error"},{status:503});}
}
