import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Snap Public Profile API. The OAuth app is created in the Snap Business Dashboard (Business Details), NOT the Developer Portal,
// and its client id must be allowlisted by Snap (email dev-support@snap.com, client id only). The app credentials live in
// Secrets Manager (elettro-brand-os-dev/snapchat-oauth, JSON {"clientId","clientSecret"}); SNAPCHAT_CLIENT_ID may override the id.
export const SNAPCHAT_CALLBACK = DEV_ORIGIN + "/api/connections/snapchat/callback";
export const SNAPCHAT_AUTHORIZE_URL = "https://accounts.snapchat.com/login/oauth2/authorize";
export const SNAPCHAT_TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
export const SNAPCHAT_PROFILE_URL = "https://businessapi.snapchat.com/v1/public_profiles/my_profile";
export const SNAPCHAT_SCOPE = "snapchat-profile-api";
export const SNAPCHAT_STATE_COOKIE = "elettro_dev_snapchat_state";
// Brands that may connect a Snapchat Public Profile (Dean has the account; which brand it belongs to is chosen on Connections).
export const SNAPCHAT_BRANDS = ["stashbox", "elettro", "therasbox", "solarmeister", "neckermann-strom"];
export const SNAPCHAT_OAUTH_SECRET = "elettro-brand-os-dev/snapchat-oauth";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

export async function snapchatApp(): Promise<{ clientId: string; clientSecret: string }> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SNAPCHAT_OAUTH_SECRET }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientId?: string; clientSecret?: string };
  const id = process.env.SNAPCHAT_CLIENT_ID || clientId;
  if (!id || !clientSecret) throw Error(`Snapchat app credentials missing: ${SNAPCHAT_OAUTH_SECRET} needs "clientId" and "clientSecret" keys`);
  return { clientId: id, clientSecret };
}
