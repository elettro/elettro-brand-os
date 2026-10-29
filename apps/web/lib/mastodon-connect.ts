import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Mastodon has no central developer portal: Elettro OS registers one app on the instance (scripts/mastodon-app-setup.sh)
// and keeps its client id/secret in Secrets Manager (elettro-brand-os-dev/mastodon-oauth). Access tokens never expire.
export const MASTODON_CALLBACK = DEV_ORIGIN + "/api/connections/mastodon/callback";
export const MASTODON_SCOPES = ["read:accounts", "write:statuses", "write:media"];
export const MASTODON_STATE_COOKIE = "elettro_dev_mastodon_state";
// SolarMeister and Neckermann Strom (German DIY homeowners and flat owners) and Stashbox (non-promotional music); other brands are not on Mastodon.
export const MASTODON_BRANDS = ["solarmeister", "neckermann-strom", "stashbox"];
// Server limit on mastodon.social; other instances differ, the API refuses an over-long post with a clear message.
export const MASTODON_POST_LIMIT = 500;

const secrets = new SecretsManagerClient({ region: "us-east-1" });

export type MastodonApp = { instance: string; clientId: string; clientSecret: string };

export async function mastodonApp(): Promise<MastodonApp> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/mastodon-oauth" }));
  const { instance, clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  if (!/^[a-z0-9.-]{3,100}$/.test(String(instance || "")) || !clientId || !clientSecret) throw Error("Mastodon app is not set up");
  return { instance, clientId, clientSecret };
}
