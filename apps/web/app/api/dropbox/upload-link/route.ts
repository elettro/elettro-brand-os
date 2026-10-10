import {NextRequest,NextResponse} from "next/server";
import {brandConfigs} from "@/lib/brand-config";
export const dynamic="force-dynamic";
const API_BASE=process.env.BRAND_OS_API_BASE_URL||process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL||"https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
// Obtain a one-time Dropbox upload link; OAuth credentials remain on AWS.
export async function POST(request:NextRequest){
 const body=await request.json().catch(()=>({})) as Record<string,unknown>;
 const brand=String(body.brand||"");const config=brandConfigs.find(x=>x.id===brand);
 if(!config)return NextResponse.json({ok:false,error:"Invalid brand"},{status:400});
 const path=String(body.path||"").replace(/\\/g,"/").replace(/\/+$/,"");
 if(path.toLowerCase()!==config.dropboxRoot.toLowerCase()&&!path.toLowerCase().startsWith(config.dropboxRoot.toLowerCase()+"/"))return NextResponse.json({ok:false,error:"Outside brand root"},{status:403});
 const filename=String(body.filename||"").trim();
 if(!filename||filename==="."||filename===".."||filename.length>180||/[\/\x00-\x1f]/.test(filename))return NextResponse.json({ok:false,error:"Invalid filename"},{status:400});
 try{
  const upstream=await fetch(`${API_BASE}/assets/bulk-update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"prepare-brand-upload",brand,path,filename}),cache:"no-store"});
  const data=await upstream.json();return NextResponse.json(data,{status:upstream.status});
 }catch(error){return NextResponse.json({ok:false,error:"Unable to request a Dropbox upload link"},{status:503});}
}
