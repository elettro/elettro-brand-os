import {NextResponse} from "next/server";
import {
 chatGptOauthConfiguration,
 MCP_OAUTH_RESOURCE,
 MCP_OAUTH_SCOPE
} from "@/lib/ai-mcp-oauth";
import {McpAuthorizationError} from "@/lib/ai-mcp-auth";

export const runtime="nodejs";
export const dynamic="force-dynamic";

// RFC 9728 protected-resource metadata for ChatGPT's OAuth discovery.
// No metadata is published until the dedicated Cognito client is configured.
// This route never accepts credentials and never exposes private asset data.
export async function GET(){
 try{
  const cfg=await chatGptOauthConfiguration();
  return NextResponse.json({
   resource:MCP_OAUTH_RESOURCE,
   authorization_servers:[cfg.issuer],
   scopes_supported:[MCP_OAUTH_SCOPE]
  },{headers:{"cache-control":"no-store"}});
 }catch(error){
  const status=error instanceof McpAuthorizationError&&error.status===404?404:503;
  return NextResponse.json({error:"ChatGPT OAuth not configured"},{
   status,headers:{"cache-control":"no-store"}
  });
 }
}
