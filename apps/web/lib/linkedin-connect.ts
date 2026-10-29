import { DEV_ORIGIN } from "@/lib/cognito-auth";
import { DAY } from "@/lib/token-expiry";

// LinkedIn Developers → app "Elettro OS Personal" (265021443, Share on LinkedIn + OpenID). The client ID is public;
// the secret lives only in Secrets Manager (elettro-brand-os-dev/linkedin-oauth).
export const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_OAUTH_CLIENT_ID || "773akyjst08f84";
export const LINKEDIN_CALLBACK = DEV_ORIGIN + "/api/connections/linkedin/callback";
export const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"];
export const LINKEDIN_STATE_COOKIE = "elettro_dev_li_state";
// Dean's personal profile is the Dean Palermo brand. Every other brand posts to its company page (one page per brand).
export const LINKEDIN_PROFILE_BRANDS = ["deanpalermo"];
export const LINKEDIN_PAGE_BRANDS = ["elettro", "stashbox", "solarmeister", "neckermann-strom", "reggaeland", "weightlossdavie"];
export const LINKEDIN_BRANDS = [...LINKEDIN_PROFILE_BRANDS, ...LINKEDIN_PAGE_BRANDS];

// Company pages: LinkedIn app "Elettro OS" (265010506, Community Management API, Development tier). Its secret lives only in
// Secrets Manager (elettro-brand-os-dev/linkedin-pages-oauth); the redirect is the same callback as the personal app.
export const LINKEDIN_PAGES_CLIENT_ID = process.env.LINKEDIN_PAGES_OAUTH_CLIENT_ID || "77ookctxp1cedr";
export const LINKEDIN_PAGES_SECRET_ID = "elettro-brand-os-dev/linkedin-pages-oauth";
export const LINKEDIN_PAGES_SCOPES = ["r_organization_social", "w_organization_social", "rw_organization_admin"];
export const LINKEDIN_PICK_COOKIE = "elettro_dev_li_pick";

// A Google Calendar "add event" link 7 days before expiry, so the reminder also lives outside Elettro OS.
export function calendarReminderUrl(expiresAt: string | Date) {
  const start = new Date(new Date(expiresAt).getTime() - 7 * DAY);
  const end = new Date(start.getTime() + 30 * 60_000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", "Reconnect LinkedIn to Elettro OS");
  url.searchParams.set("dates", `${stamp(start)}/${stamp(end)}`);
  url.searchParams.set("details", `The LinkedIn login expires ${new Date(expiresAt).toUTCString()}. Reconnect: ${DEV_ORIGIN}/connections`);
  return url.toString();
}

// Posts API version header (YYYYMM); LinkedIn keeps each version for about a year.
export const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202608";

// Posts "commentary" uses LinkedIn's little text format, where these characters are markup unless escaped.
export function littleText(text: string) {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => "\\" + c);
}
