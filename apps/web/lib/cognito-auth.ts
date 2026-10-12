import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const COGNITO_DOMAIN = "https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com";
export const COGNITO_CLIENT_ID = "34u0cdg0b3tl2mv6qti19e09oq";
export const DEV_ORIGIN = "https://develop.d2k28tehm1a8zw.amplifyapp.com";
export const CALLBACK = DEV_ORIGIN + "/api/auth/callback";
const PREFIX = "elettro_dev_";

function secret(): string {
  const value = process.env.ELETTRO_AUTH_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("ELETTRO_AUTH_SESSION_SECRET is not configured (at least 32 random characters)");
  return value;
}
export function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}
export function seal(value: string): string {
  return value + "." + sign(value);
}
export function unseal(input: string | undefined): string | null {
  if (!input) return null;
  const idx = input.lastIndexOf(".");
  if (idx < 1) return null;
  const value = input.slice(0, idx);
  const actual = Buffer.from(input.slice(idx + 1));
  const expected = Buffer.from(sign(value));
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? value : null;
}
export function challenge(): string { return randomBytes(24).toString("base64url"); }
export function cookieSettings(maxAge: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge };
}
export async function authenticated(): Promise<boolean> {
  try {
    const store = await cookies();
    const payload = unseal(store.get(PREFIX+"session")?.value);
    if (!payload) return false;
    const [email, expiration] = payload.split("|");
    const allowed = process.env.ELETTRO_OWNER_EMAIL?.toLowerCase();
    return !!allowed && email.toLowerCase() === allowed && Number(expiration) > Date.now();
  } catch { return false; }
}
export const AUTH_COOKIE = PREFIX + "session";
export const STATE_COOKIE = PREFIX + "state";
