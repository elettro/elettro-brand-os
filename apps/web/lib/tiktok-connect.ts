import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN } from "@/lib/cognito-auth";

// TikTok for Developers → org "Elettro" → app "Elettro OS" (7698722090002810901), sandbox "Elettro OS Dev".
// Sandbox and production have different client keys, so both key and secret come from
// Secrets Manager (elettro-brand-os-dev/tiktok-oauth, plain JSON {"clientKey","clientSecret"}).
export const TIKTOK_CALLBACK = DEV_ORIGIN + "/api/connections/tiktok/callback";
// Login Kit + Content Posting API (Direct Post on) + profile, stats and video list for analytics.
export const TIKTOK_SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
  "video.list",
  "video.upload",
  "video.publish"
];
export const TIKTOK_STATE_COOKIE = "elettro_dev_tiktok_state";
// Stashbox (@stashboxmusic) first. SolarMeister (@solarmeistershop, private) is the account for
// unaudited direct posts and the review demo. While the app is unaudited each account must be a sandbox
// Target User, and posts can only go out as SELF_ONLY (private).
export const TIKTOK_BRANDS = ["stashbox", "elettro", "therasbox", "solarmeister"];
export const TIKTOK_OAUTH_SECRET = "elettro-brand-os-dev/tiktok-oauth";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

export async function tiktokApp(): Promise<{ clientKey: string; clientSecret: string }> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: TIKTOK_OAUTH_SECRET }));
  const { clientKey, clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientKey?: string; clientSecret?: string };
  if (!clientKey || !clientSecret) throw Error(`TikTok app keys missing: ${TIKTOK_OAUTH_SECRET} needs "clientKey" and "clientSecret"`);
  return { clientKey, clientSecret };
}
