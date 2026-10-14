import {NextResponse} from "next/server";
import {COGNITO_DOMAIN} from "@/lib/cognito-auth";
import {
 chatGptOauthConfiguration,
 MCP_OAUTH_AUTHORIZATION_SERVER,
 MCP_OAUTH_SCOPE
} from "@/lib/ai-mcp-oauth";
import {McpAuthorizationError} from "@/lib/ai-mcp-auth";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/**
 * DEV-only RFC 8414 discovery facade for ChatGPT's strict MCP OAuth client.
 *
 * Cognito supports authorization-code + S256 PKCE but its hosted discovery
 * document does not currently advertise code_challenge_methods_supported.
 * This endpoint fills that metadata gap without proxying token traffic or
 * creating credentials. Authentication and JWT verification remain Cognito's.
 *
 * The facade intentionally does NOT claim RFC 9207 authorization response
 * issuer support: Cognito does not return our facade issuer in callbacks.
 * ChatGPT must continue using the callback-specific redirect URI registered
 * with the dedicated public Cognito app client.
 */
export async function GET(){
 try{
  await chatGptOauthConfiguration();
  return NextResponse.json({
   issuer:MCP_OAUTH_AUTHORIZATION_SERVER,
   authorization_endpoint:COGNITO_DOMAIN+"/oauth2/authorize",
   token_endpoint:COGNITO_DOMAIN+"/oauth2/token",
   response_types_supported:["code"],
   grant_types_supported:["authorization_code","refresh_token"],
   token_endpoint_auth_methods_supported:["none","client_secret_basic","client_secret_post"],
   code_challenge_methods_supported:["S256"],
   scopes_supported:["openid","email",MCP_OAUTH_SCOPE],
   userinfo_endpoint:COGNITO_DOMAIN+"/oauth2/userInfo"
  },{headers:{"cache-control":"no-store"}});
 }catch(error){
  const status=error instanceof McpAuthorizationError&&error.status===404?404:503;
  return NextResponse.json({error:"ChatGPT OAuth not configured"},{
   status,headers:{"cache-control":"no-store"}
  });
 }
}
