import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, CALLBACK, COGNITO_CLIENT_ID, COGNITO_DOMAIN, DEV_ORIGIN, STATE_COOKIE, cookieSettings, unseal, serverSetting, seal } from "@/lib/cognito-auth";
import { createPublicKey, verify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
export const runtime = "nodejs";
async function verifiedClaims(jwt: string): Promise<Record<string,unknown>> {
  const [header, body, signature] = jwt.split(".");
  if (!header || !body || !signature) throw Error("Malformed identity token");
  const parsedHeader = JSON.parse(Buffer.from(header,"base64url").toString()) as {kid?:string;alg?:string};
  if (parsedHeader.alg !== "RS256" || !parsedHeader.kid) throw Error("Invalid token algorithm");
  // Take the issuer candidate from the token and strictly limit it to Cognito
  // in our fixed AWS region. Its authenticity is verified with the fetched JWK.
  // This avoids relying on an Amplify build-time variable at SSR runtime.
  const unverified = JSON.parse(Buffer.from(body,"base64url").toString()) as Record<string,unknown>;
  const issuer = String(unverified.iss || "");
  if (!/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[A-Za-z0-9]+$/.test(issuer)) throw Error("Cognito issuer invalid");
  let response: Response;
  try {
    response = await fetch(issuer + "/.well-known/jwks.json",{cache:"no-store",signal:AbortSignal.timeout(8000)});
  } catch {
    throw Error("Cognito signing keys network failure");
  }
  if (!response.ok) throw Error("Cognito signing keys HTTP "+response.status);
  const keys = await response.json() as {keys: Array<JsonWebKey & {kid?:string}>};
  const jwk=keys.keys.find(key=>key.kid===parsedHeader.kid);
  if (!jwk) throw Error("Unknown Cognito signing key");
  if (!verify("RSA-SHA256",Buffer.from(header+"."+body),createPublicKey({key:jwk as NodeJsonWebKey,format:"jwk"}),Buffer.from(signature,"base64url"))) throw Error("Identity signature invalid");
  const claims=JSON.parse(Buffer.from(body,"base64url").toString()) as Record<string,unknown>;
  if (claims.iss !== issuer || claims.aud !== COGNITO_CLIENT_ID || claims.token_use !== "id" || Number(claims.exp)*1000 <= Date.now()) throw Error("Identity token invalid");
  return claims;
}
export async function GET(request:NextRequest) {
  try {
    const state=await unseal(request.cookies.get(STATE_COOKIE)?.value);
    if (!state || state !== request.nextUrl.searchParams.get("state")) throw Error("Invalid OAuth state");
    const code=request.nextUrl.searchParams.get("code");
    if (!code) throw Error("Missing authorization code");
    const clientSecret=await serverSetting("ELETTRO_COGNITO_CLIENT_SECRET");
    if (!clientSecret) throw Error("Cognito client secret is not configured");
    const basic=Buffer.from(COGNITO_CLIENT_ID+":"+clientSecret).toString("base64");
    const tokens=await fetch(COGNITO_DOMAIN+"/oauth2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","authorization":"Basic "+basic},body:new URLSearchParams({grant_type:"authorization_code",client_id:COGNITO_CLIENT_ID,code,redirect_uri:CALLBACK}),cache:"no-store"});
    if (!tokens.ok) throw Error("Cognito rejected authentication");
    const data=await tokens.json() as {id_token?:string};
    if (!data.id_token) throw Error("Missing identity token");
    const claims=await verifiedClaims(data.id_token);
    const email=String(claims.email||"").toLowerCase();
    if (!email || claims.email_verified !== true || email !== (process.env.ELETTRO_OWNER_EMAIL || "dpalermo@elettro.com").toLowerCase()) throw Error("Account not authorized");
    const destination=NextResponse.redirect(DEV_ORIGIN+"/assets/add");
    const expiration=Date.now()+8*60*60*1000;
    destination.cookies.set(AUTH_COOKIE,await seal(email+"|"+expiration),cookieSettings(8*60*60));
    destination.cookies.delete(STATE_COOKIE);
    return destination;
  } catch(error) {
    console.error("Cognito callback error:",error instanceof Error?error.message:"unknown");
    const message=error instanceof Error?error.message:"Unknown";
    const safeReason=message==="Invalid OAuth state"?"state":
      message==="Cognito rejected authentication"?"token_exchange":
      message==="Account not authorized"?"owner_not_authorized":
      message==="Cognito user pool is not configured"?"pool_config":
      message==="Identity token invalid"?"identity_token":
      message==="Identity signature invalid"?"identity_signature":
      message==="Unknown Cognito signing key"?"jwks_key":
      message==="Unable to load Cognito signing keys"?"jwks_fetch":
      message==="Cognito signing keys network failure"?"jwks_network":
      message.startsWith("Cognito signing keys HTTP ")?"jwks_http_"+message.slice(25):
      message==="Cognito issuer invalid"?"issuer_invalid":
      message==="Cognito client secret is not configured"?"client_secret":
      message==="Missing authorization code"?"missing_code":
      message==="Session signing key is too short"?"session_secret_short":
      message.includes("ELETTRO_COGNITO_CLIENT_SECRET")?"client_secret_read":
      message.includes("ELETTRO_AUTH_SESSION_SECRET")?"session_secret_read":
      error instanceof Error && error.name==="ParameterNotFound"?"ssm_parameter_missing":
      error instanceof Error && error.name==="AccessDeniedException"?"ssm_access_denied":
      "callback_unexpected";
    return NextResponse.redirect(DEV_ORIGIN+"/auth/error?reason="+safeReason);
  }
}
