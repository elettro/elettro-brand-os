import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN } from "@/lib/cognito-auth";

// One Elettro OS "web app" in Reddit's app registry (reddit.com/prefs/apps). Its client id/secret live in Secrets Manager
// (elettro-brand-os-dev/reddit-oauth, made by scripts/reddit-app-setup.sh). Access tokens last 1 hour; with duration=permanent
// Reddit also issues a refresh token that does not rotate and does not expire (until the user revokes the app).
// New apps need Reddit's approval under the Responsible Builder Policy before the token endpoint works.
export const REDDIT_CALLBACK = DEV_ORIGIN + "/api/connections/reddit/callback";
export const REDDIT_SCOPES = ["identity", "submit"];
export const REDDIT_STATE_COOKIE = "elettro_dev_reddit_state";
// Same seven active brands as X. Dean Palermo, Rompe and Reggae.Land join in Nov 2026; `google-review` is the demo brand.
export const REDDIT_BRANDS: string[] = ["stashbox", "elettro", "therasbox", "solarmeister", "weightlossdavie", "pianomusicsoothing", "neckermann-strom"];
// Reddit requires a unique, descriptive User-Agent; generic ones are throttled.
export const REDDIT_USER_AGENT = "web:com.elettro.os:v1.0 (by /u/stashboxcom)";
export const REDDIT_TITLE_LIMIT = 300;
export const REDDIT_TEXT_LIMIT = 40000;
export const REDDIT_TOKEN_PREFIX = "elettro-brand-os-dev/reddit/";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

export type RedditApp = { clientId: string; clientSecret: string };
export type RedditAccountTokens = {
  accessToken: string; refreshToken: string | null; expiresAt: string | null; scope: string | null;
  accountId: string; username: string; brand: string; connectedAt?: string;
};

export async function redditApp(): Promise<RedditApp> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/reddit-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  if (!clientId || !clientSecret) throw Error("Reddit app is not set up");
  return { clientId, clientSecret };
}

export function redditBasicAuth(app: RedditApp) {
  return "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
}

// A valid access token for the account: reuse the saved one while it has over a minute left, otherwise refresh.
// The refresh token is long-lived and is not replaced, but the new access token is saved so the next call can reuse it.
export async function freshRedditToken(secretName: string, saved: RedditAccountTokens): Promise<string> {
  const left = saved.expiresAt ? Date.parse(saved.expiresAt) - Date.now() : 0;
  if (saved.accessToken && left > 60_000) return saved.accessToken;
  if (!saved.refreshToken) throw Error("Reddit login expired; reconnect Reddit");
  const app = await redditApp();
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: redditBasicAuth(app), "user-agent": REDDIT_USER_AGENT },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!response.ok || !token.access_token) throw Error(`Reddit login expired; reconnect Reddit (${token.error || response.status})`);
  const next: RedditAccountTokens = {
    ...saved, accessToken: token.access_token,
    expiresAt: new Date(Date.now() + (token.expires_in || 3600) * 1000).toISOString(), scope: token.scope || saved.scope
  };
  await secrets.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(next) }));
  return next.accessToken;
}
