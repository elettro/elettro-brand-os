import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

export const COGNITO_DOMAIN = "https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com";
export const COGNITO_CLIENT_ID = "34u0cdg0b3tl2mv6qti19e09oq";
export const DEV_ORIGIN = "https://develop.d2k28tehm1a8zw.amplifyapp.com";
export const CALLBACK = DEV_ORIGIN + "/api/auth/callback";
const PREFIX = "elettro_dev_";

const ssm = new SSMClient({region:"us-east-1"});
const SECRET_PATH="/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/";
export async function serverSetting(name: "ELETTRO_AUTH_SESSION_SECRET" | "ELETTRO_COGNITO_CLIENT_SECRET"): Promise<string> {
  if (process.env[name]) return process.env[name]!;
  if (process.env.AWS_BRANCH && process.env.AWS_BRANCH !== "develop") throw Error("Authentication is configured for DEV only");
  const result=await ssm.send(new GetParameterCommand({Name: SECRET_PATH+name, WithDecryption:true}));
  if (!result.Parameter?.Value) throw Error(name+" is unavailable to the server");
  return result.Parameter.Value;
}
async function sign(value: string): Promise<string> {
  const key=await serverSetting("ELETTRO_AUTH_SESSION_SECRET");
  if (key.length<32) throw Error("Session signing key is too short");
  return createHmac("sha256",key).update(value).digest("base64url");
}
export async function seal(value: string): Promise<string> {return value+"."+await sign(value);}
export async function unseal(input: string | undefined): Promise<string|null> {
  if (!input) return null;
  const idx=input.lastIndexOf(".");
  if (idx<1) return null;
  const value=input.slice(0,idx);
  const actual=Buffer.from(input.slice(idx+1));
  const expected=Buffer.from(await sign(value));
  return actual.length===expected.length && timingSafeEqual(actual,expected)?value:null;
}
export function challenge(): string { return randomBytes(24).toString("base64url"); }
export function cookieSettings(maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge };
}
export async function authenticated(): Promise<boolean> {
  try {
    const store = await cookies();
    const payload = await unseal(store.get(PREFIX+"session")?.value);
    if (!payload) return false;
    const [email, expiration] = payload.split("|");
    const allowed = process.env.ELETTRO_OWNER_EMAIL?.toLowerCase();
    return !!allowed && email.toLowerCase() === allowed && Number(expiration) > Date.now();
  } catch { return false; }
}
export const AUTH_COOKIE = PREFIX + "session";
export const STATE_COOKIE = PREFIX + "state";
