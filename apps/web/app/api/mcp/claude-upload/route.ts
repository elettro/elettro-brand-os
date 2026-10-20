import {NextRequest,NextResponse} from "next/server";
import {handleClaudeUploadPage} from "@/lib/ai-mcp-claude-upload";
import {GatewayError} from "@/lib/ai-gateway";
import {allowedOrigin} from "@/lib/cognito-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const MAX_BODY=3*1024*1024;
const headers={"cache-control":"no-store","referrer-policy":"no-referrer"};
export async function POST(request:NextRequest){
 if(!allowedOrigin(request.headers.get("origin"))||(request.headers.get("content-type")||"").split(";")[0]!=="application/json")
  return NextResponse.json({ok:false,error:"Same-origin JSON required"},{status:403,headers});
 if(Number(request.headers.get("content-length")||0)>MAX_BODY)return NextResponse.json({ok:false,error:"Chunk too large"},{status:413,headers});
 try{
  const reader=request.body?.getReader();if(!reader)throw new GatewayError(400,"Body required");
  const parts:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
   if(size>MAX_BODY)throw new GatewayError(413,"Chunk too large");parts.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const input=JSON.parse(Buffer.concat(parts).toString());
  const result=await handleClaudeUploadPage(input);
  return NextResponse.json(result,{headers});
 }catch(error){return NextResponse.json({ok:false,error:error instanceof GatewayError?error.message:"Upload request unavailable. Retry completion before uploading again."},
  {status:error instanceof GatewayError?error.status:502,headers});}
}
