import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, CALLBACK, COGNITO_CLIENT_ID, COGNITO_DOMAIN, DEV_ORIGIN, STATE_COOKIE, cookieSettings, unseal } from "@/lib/cognito-auth";
import { createPublicKey, verify } from "node:crypto";
export const runtime = "nodejs";
async function verifiedClaims(jwt: string): Promise<Record<string,unknown>> {
  const [header, body, signature] = jwt.split(".");
  if (!header || !body || !signature) throw Error("Malformed identity token");
  const parsedHeader = JSON.parse(Buffer.from(header,"base64url").toString()) as {kid?:string;alg?:string};
  if (parsedHeader.alg !== "RS256" || !parsedHeader.kid) throw Error("Invalid token algorithm");
  const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_YDbEhB7ps";
  const response = await fetch(issuer + "/.well-known/jwks.json",{cache:"no-store"});
  if (!response.ok) throw Error("Unable to load Cognito signing keys");
  const keys = await response.json() as {keys: Array<JsonWebKey & {kid?:string}>};
  const jwk=keys.keys.find(key=>key.kid===parsedHeader.kid);
  if (!jwk) throw Error("Unknown Cognito signing key");
  if (!verify("RSA-SHA256",Buffer.from(header+"."+body),createPublicKey({key:jwk,format:"jwk"}),Buffer.from(signature,"base64url"))) throw Error("Identity signature invalid");
  const claims=JSON.parse(Buffer.from(body,"base64url").toString()) as Record<string,unknown>;
  if (claims.iss !== issuer || claims.aud !== COGNITO_CLIENT_ID || claims.token_use !== "id" || Number(claims.exp)*1000 <= Date.now()) throw Error("Identity token invalid");
  return claims;
}
export async function GET(request:NextRequest) {
  try {
    const state=unseal(request.cookies.get(STATE_COOKIE)?.value);
    if (!state || state !== request.nextUrl.searchParams.get("state")) throw Error("Invalid OAuth state");
    const code=request.nextUrl.searchParams.get("code");
    if (!code) throw Error("Missing authorization code");
    const clientSecret=process.env.ELETTRO_COGNITO_CLIENT_SECRET;
    if (!clientSecret) throw Error("Cognito client secret is not configured");
    const basic=Buffer.from(COGNITO_CLIENT_ID+":"+clientSecret).toString("base64");
    const tokens=await fetch(COGNITO_DOMAIN+"/oauth2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","authorization":"Basic "+basic},body:new URLSearchParams({grant_type:"authorization_code",client_id:COGNITO_CLIENT_ID,code,redirect_uri:CALLBACK}),cache:"no-store"});
    if (!tokens.ok) throw Error("Cognito rejected authentication");
    const data=await tokens.json() as {id_token?:string};
    if (!data.id_token) throw Error("Missing identity token");
    const claims=await verifiedClaims(data.id_token);
    const email=String(claims.email||"").toLowerCase();
    if (!email || claims.email_verified !== true || email !== process.env.ELETTRO_OWNER_EMAIL?.toLowerCase()) throw Error("Account not authorized");
    const destination=NextResponse.redirect(DEV_ORIGIN+"/assets/add");
    const expiration=Date.now()+8*60*60*1000;
    const {seal}=await import("@/lib/cognito-auth");
    destination.cookies.set(AUTH_COOKIE,seal(email+"|"+expiration),cookieSettings(8*60*60));
    destination.cookies.delete(STATE_COOKIE);
    return destination;
  } catch(error) {
    console.error("Cognito callback error:",error instanceof Error?error.message:"unknown");
    return NextResponse.redirect(DEV_ORIGIN+"/?auth=error");
  }
}
