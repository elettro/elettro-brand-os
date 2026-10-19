// Tokens that expire without a refresh token (LinkedIn members today, Meta next): warn across the app
// 14 days out, alarm at 3. Pure so the client countdown and banner can share it.
export const REMIND_DAYS = 14;
export const URGENT_DAYS = 3;
export const DAY = 86_400_000;

export type ExpiryLevel = "ok" | "soon" | "urgent" | "expired";

export function expiryLevel(expiresAt: string | Date, now = Date.now()): ExpiryLevel {
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return "expired";
  if (left <= URGENT_DAYS * DAY) return "urgent";
  if (left <= REMIND_DAYS * DAY) return "soon";
  return "ok";
}

export function daysLeft(expiresAt: string | Date, now = Date.now()) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / DAY));
}
