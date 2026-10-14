import {createPublicKey,verify,type JsonWebKey as NodeJsonWebKey} from "node:crypto";
import {COGNITO_DOMAIN,DEV_ORIGIN} from "@/lib/cognito-auth";
import {brandConfigs} from "@/lib/brand-config";
import {loadMcpAuthSettings,McpAuthorizationError,type McpIdentity} from "@/lib/ai-mcp-auth";

/**
 * DEV-only OAuth compatibility for ChatGPT's custom MCP connector.
 * Requires a dedicated PUBLIC Cognito authorization-code+PKCE app client,
 * a resource binding to this exact MCP URL, and the custom scope
 * "elettro-mcp/read". This code never mints, exchanges, or stores tokens.
 *
 * Existing 43-character static Claude bearer tokens are handled separately.
 * Unless the dedicated Cognito configuration is explicitly provisioned in
 * the already encrypted SSM MCP parameter, OAuth fails closed.
 */
export const MCP_OAUTH_RESOURCE=DEV_ORIGIN+"/api/mcp";
export const MCP_OAUTH_METADATA=DEV_ORIGIN+"/.well-known/oauth-protected-resource";
export const MCP_OAUTH_SCOPE="elettro-mcp/read";
export const MCP_OAUTH_WRITE_SCOPE="elettro-mcp/write";
const ISSUER_PATTERN=/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[A-Za-z0-9]+$/;
const CLIENT_PATTERN=/^[a-z0-9]{10,128}$/i;
const MAX_JWT_LENGTH=16384;

export type ChatGptOAuthConfiguration={issuer:string;clientId:string;enabled:true};

export async function chatGptOauthConfiguration():Promise<ChatGptOAuthConfiguration>{
 const settings=await loadMcpAuthSettings();
 const candidate=settings.chatgptOauth;
 if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))
  throw new McpAuthorizationError(503,"ChatGPT OAuth is not provisioned");
 const cfg=candidate as Record<string,unknown>;
 if(cfg.enabled!==true||typeof cfg.issuer!=="string"||!ISSUER_PATTERN.test(cfg.issuer)||
   typeof cfg.clientId!=="string"||!CLIENT_PATTERN.test(cfg.clientId))
  throw new McpAuthorizationError(503,"ChatGPT OAuth configuration incomplete");
 return {issuer:cfg.issuer,clientId:cfg.clientId,enabled:true};
}

export function oauthChallenge(){
 return 'Bearer resource_metadata="'+MCP_OAUTH_METADATA+'", scope="'+MCP_OAUTH_SCOPE+'"';
}

function jwtPart<T>(raw:string):T{
 if(!/^[A-Za-z0-9_-]{1,10000}$/.test(raw))throw new McpAuthorizationError(401,"Invalid OAuth token");
 try{return JSON.parse(Buffer.from(raw,"base64url").toString("utf8")) as T;}
 catch{throw new McpAuthorizationError(401,"Invalid OAuth token");}
}

type OAuthJwtClaims={
 iss?:unknown;exp?:unknown;nbf?:unknown;iat?:unknown;token_use?:unknown;
 client_id?:unknown;aud?:unknown;sub?:unknown;scope?:unknown;
};
export async function authorizeChatGptOauth(header:string):Promise<McpIdentity>{
 // A strict JWT shape prevents a JWT from being confused with Claude's
 // opaque 43-character bearer token.
 if(!header.startsWith("Bearer ")||header.length>MAX_JWT_LENGTH)
  throw new McpAuthorizationError(401,"Invalid OAuth token");
 const jwt=header.slice(7);
 const pieces=jwt.split(".");
 if(pieces.length!==3||pieces.some(x=>!/^[A-Za-z0-9_-]{1,10000}$/.test(x)))
  throw new McpAuthorizationError(401,"Invalid OAuth token");
 const [head,payload,sig]=pieces;
 const jwtHeader=jwtPart<{alg?:unknown;kid?:unknown;typ?:unknown}>(head);
 const claims=jwtPart<OAuthJwtClaims>(payload);
 if(jwtHeader.alg!=="RS256"||typeof jwtHeader.kid!=="string"||jwtHeader.kid.length>256||
   !claims||typeof claims!=="object")
  throw new McpAuthorizationError(401,"OAuth signing algorithm invalid");

 // Never fetch signing keys from an unverified token claim. The issuer comes
 // only from the DEV owner's encrypted MCP configuration.
 const cfg=await chatGptOauthConfiguration();
 if(claims.iss!==cfg.issuer||claims.token_use!=="access"||
   claims.client_id!==cfg.clientId||claims.aud!==MCP_OAUTH_RESOURCE||
   typeof claims.sub!=="string"||!claims.sub||
   typeof claims.scope!=="string"||!claims.scope.split(" ").includes(MCP_OAUTH_SCOPE))
  throw new McpAuthorizationError(401,"OAuth token claims denied");

 const now=Math.floor(Date.now()/1000);
 if(typeof claims.exp!=="number"||claims.exp<=now||
   typeof claims.iat!=="number"||claims.iat>now+60||
   (claims.nbf!==undefined&&(typeof claims.nbf!=="number"||claims.nbf>now+60)))
  throw new McpAuthorizationError(401,"OAuth token expired or not valid");

 let jwksResponse:Response;
 try{
  jwksResponse=await fetch(cfg.issuer+"/.well-known/jwks.json",{
   cache:"no-store",signal:AbortSignal.timeout(8000),redirect:"error"
  });
 }catch{throw new McpAuthorizationError(503,"OAuth signing key service unavailable");}
 if(!jwksResponse.ok)throw new McpAuthorizationError(503,"OAuth signing key service unavailable");
 let publicKeys:{keys?:Array<NodeJsonWebKey & {kid?:string;alg?:string;use?:string}>};
 try{publicKeys=await jwksResponse.json();}
 catch{throw new McpAuthorizationError(503,"OAuth signing key data invalid");}
 const match=Array.isArray(publicKeys.keys)&&publicKeys.keys.find(k=>
  k.kid===jwtHeader.kid&&k.kty==="RSA"&&(!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig")
 );
 if(!match)throw new McpAuthorizationError(401,"OAuth signing key not recognized");
 try{
  const good=verify("RSA-SHA256",Buffer.from(head+"."+payload),
   createPublicKey({key:match as NodeJsonWebKey,format:"jwk"}),Buffer.from(sig,"base64url"));
  if(!good)throw Error("invalid signature");
 }catch{throw new McpAuthorizationError(401,"OAuth token signature invalid");}

 // Cognito access tokens do not always contain email claims. Verify the
 // authenticated person at Cognito's UserInfo endpoint, requiring the Cognito
 // verified owner email AND matching subject. No untrusted user email bypass.
 let userInfo:Response;
 try{
  userInfo=await fetch(COGNITO_DOMAIN+"/oauth2/userInfo",{
   headers:{authorization:header,accept:"application/json"},
   cache:"no-store",signal:AbortSignal.timeout(8000),redirect:"error"
  });
 }catch{throw new McpAuthorizationError(503,"OAuth owner identity unavailable");}
 if(!userInfo.ok)throw new McpAuthorizationError(401,"OAuth owner identity denied");
 let user:Record<string,unknown>;
 try{user=await userInfo.json();}
 catch{throw new McpAuthorizationError(401,"OAuth owner identity invalid");}
 const expected=(process.env.ELETTRO_OWNER_EMAIL||"dpalermo@elettro.com").toLowerCase();
 if(user.sub!==claims.sub||typeof user.email!=="string"||
   user.email.toLowerCase()!==expected||user.email_verified!==true)
  throw new McpAuthorizationError(403,"ChatGPT owner identity denied");

 // Only a signed token with the explicit new custom write scope can enable
 // controlled metadata, folder, and staged upload tools. Publishing and
 // arbitrary registration remain excluded regardless of supplied scopes.
 return {
  clientId:"chatgpt_oauth",
  brandSlugs:brandConfigs.map(brand=>brand.id),
  permissions:claims.scope.split(" ").includes(MCP_OAUTH_WRITE_SCOPE)
   ? ["assets:read","folders:read","assets:write","folders:write","assets:upload"]
   : ["assets:read","folders:read"]
 };
}
