import { NextRequest, NextResponse } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { authenticated } from "@/lib/cognito-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const secrets = new SecretsManagerClient({region:"us-east-1"});
export async function POST(request:NextRequest) {
  if (!(await authenticated())) return NextResponse.json({error:"Login required"},{status:401});
  if (request.headers.get("origin") !== "https://develop.d2k28tehm1a8zw.amplifyapp.com") return NextResponse.json({error:"Invalid origin"},{status:403});
  try {
    const result=await secrets.send(new GetSecretValueCommand({SecretId:"elettro-brand-os-dev/dropbox"}));
    const settings=JSON.parse(result.SecretString||"{}") as Record<string,string>;
    const refresh=settings.refresh_token||settings.refreshToken;
    const key=settings.app_key||settings.appKey;
    const secret=settings.app_secret||settings.appSecret;
    if(!refresh || !key || !secret) throw Error("Dropbox refresh credentials are missing");
    const response=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,client_id:key,client_secret:secret}),
      cache:"no-store"});
    if(!response.ok) throw Error("Dropbox token refresh HTTP "+response.status);
    const data=await response.json() as {access_token?:string;expires_in?:number};
    if(!data.access_token) throw Error("Dropbox returned no access token");
    return NextResponse.json({accessToken:data.access_token,expiresIn:data.expires_in||14400},
      {headers:{"cache-control":"no-store, private","pragma":"no-cache"}});
  } catch(error) {
    console.error("Authenticated Dropbox token issue:",error instanceof Error?error.name:"Unknown");
    return NextResponse.json({error:"Fast Dropbox authorization unavailable; secure AWS uploader remains available"},{status:503,headers:{"cache-control":"no-store"}});
  }
}
