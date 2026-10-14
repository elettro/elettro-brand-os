import {NextRequest,NextResponse} from "next/server";
import {DEV_ORIGIN} from "@/lib/cognito-auth";
import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";
import {batchUpdateAssetMetadata} from "@/lib/ai-gateway-batch";
import {authorizeMcp,requireMcpScope,McpAuthorizationError} from "@/lib/ai-mcp-auth";
import {authorizeChatGptOauth,oauthChallenge} from "@/lib/ai-mcp-oauth";
import {findAuthorizedTool,toolsForClient} from "@/lib/ai-mcp-tools";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const MAX_BODY=64*1024;
const headers={"cache-control":"no-store","mcp-protocol-version":"2025-06-18"};
// An Origin is an advisory CSRF/DNS-rebinding signal, never authentication.
// Cloud MCP hosts may send their own Origin; all requests still require a
// valid independently scoped Bearer credential from AWS SSM.
const allowedMcpOrigins=new Set([DEV_ORIGIN,"https://claude.ai","https://chatgpt.com"]);

type RpcMessage={jsonrpc?:string;id?:string|number|null;method?:string;params?:unknown};
function success(id:RpcMessage["id"],result:unknown){
 return NextResponse.json({jsonrpc:"2.0",id,result},{headers});
}
function rpcError(id:RpcMessage["id"],code:number,message:string){
 return NextResponse.json({jsonrpc:"2.0",id:id??null,error:{code,message}},{headers});
}

export async function POST(request:NextRequest){
 const origin=request.headers.get("origin");
 if(origin&&!allowedMcpOrigins.has(origin))
  return NextResponse.json({error:"Invalid origin"},{status:403,headers});
 if(!(request.headers.get("content-type")||"").startsWith("application/json"))
  return NextResponse.json({error:"JSON required"},{status:415,headers});
 if(Number(request.headers.get("content-length")||0)>MAX_BODY)
  return NextResponse.json({error:"Request too large"},{status:413,headers});

 let identity;
 try{
  const bearer=request.headers.get("authorization");
  // Distinct credentials with no fallback: JWTs are Cognito+PKCE OAuth tokens;
  // opaque bearer tokens retain the independently scoped Claude SSM hash path.
  identity=bearer&&/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)
   ? await authorizeChatGptOauth(bearer)
   : await authorizeMcp(bearer);
 }catch(error){
  const responseHeaders=error instanceof McpAuthorizationError&&error.status===401
   ? {...headers,"www-authenticate":oauthChallenge()}
   : headers;
  if(error instanceof McpAuthorizationError)
   return NextResponse.json({error:error.message},{status:error.status,headers:responseHeaders});
  return NextResponse.json({error:"MCP authentication unavailable"},{status:503,headers});
 }

 const raw=await request.text();
 if(raw.length>MAX_BODY)
  return NextResponse.json({error:"Request too large"},{status:413,headers});
 let message:RpcMessage;
 try{message=JSON.parse(raw) as RpcMessage;}
 catch{return rpcError(null,-32700,"Parse error");}
 if(!message||typeof message!=="object"||Array.isArray(message)||
    message.jsonrpc!=="2.0"||typeof message.method!=="string")
  return rpcError(null,-32600,"Invalid JSON-RPC request");
 const id=message.id;

 if(message.method==="notifications/initialized")
  return new NextResponse(null,{status:202,headers});

 if(id===undefined||id===null||!(typeof id==="string"||typeof id==="number"))
  return rpcError(null,-32600,"Request id required");

 if(message.method==="initialize")
  return success(id,{
   protocolVersion:"2025-06-18",
   capabilities:{tools:{listChanged:false}},
   serverInfo:{name:"elettro-ai-gateway",version:"0.1.0"},
   instructions:"Brand content only. Confirm mutations with the user before calling. The dashboard remains primary. Stock asset operations are paused."
  });
 if(message.method==="ping")return success(id,{});
 if(message.method==="tools/list")
  return success(id,{tools:toolsForClient(identity)});
 if(message.method==="tools/call"){
  const p=message.params;
  if(!p||typeof p!=="object"||Array.isArray(p))
   return rpcError(id,-32602,"Tool parameters required");
  const call=p as {name?:unknown;arguments?:unknown};
  if(typeof call.name!=="string")
   return rpcError(id,-32602,"Tool name required");
  const tool=findAuthorizedTool(call.name,identity);
  if(!tool)return rpcError(id,-32601,"Unknown or unauthorized tool");
  if(!call.arguments||typeof call.arguments!=="object"||Array.isArray(call.arguments))
   return rpcError(id,-32602,"Tool arguments required");
  const args=call.arguments as Record<string,unknown>;
  try{
   requireMcpScope(identity,tool.permission,args.brandSlug);
   // Action and Dropbox scope are server-owned: caller cannot override them.
   const result=tool.action==="batch_update_asset_metadata"
    ? await batchUpdateAssetMetadata(args)
    : await executeAiGateway({...args,action:tool.action,scope:"brand"});
   const readOnlyActions=new Set(["search_assets","get_asset","inspect_registered_asset",
     "inspect_global_dropbox_id","inspect_brand_registration","list_folders"]);
   if(!readOnlyActions.has(tool.action))
    console.info("Elettro MCP audit",JSON.stringify({
      provider:identity.clientId,action:tool.action,brandSlug:args.brandSlug,
      assetId:typeof args.assetId==="string"?args.assetId:undefined,
      outcome:result.ok===false?"partial":"success",timestamp:new Date().toISOString()
    }));
   return success(id,{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result,isError:result.ok===false});
  }catch(error){
   const known=error instanceof GatewayError||error instanceof McpAuthorizationError;
   const messageText=known?error.message:"Elettro operation unavailable";
   console.error("Elettro MCP audit",JSON.stringify({
     provider:identity.clientId,action:tool.action,brandSlug:args.brandSlug,
     assetId:typeof args.assetId==="string"?args.assetId:undefined,
     outcome:"error",timestamp:new Date().toISOString(),
     error:known?messageText:"Internal error"
   }));
   return success(id,{content:[{type:"text",text:messageText}],isError:true});
  }
 }
 return rpcError(id,-32601,"Unsupported MCP method");
}
export async function GET(){
 return new NextResponse(null,{status:405,headers:{...headers,allow:"POST"}});
}
export async function DELETE(){
 return new NextResponse(null,{status:405,headers:{...headers,allow:"POST"}});
}
