import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";

// One Elettro OS app in the X developer portal (OAuth 2.0, confidential client, PKCE). Its client id/secret live in
// Secrets Manager (elettro-brand-os-dev/x-oauth, made by scripts/x-app-setup.sh). Access tokens last about 2 hours and the
// refresh token rotates on use, so every use refreshes first and writes the new pair back to the account's secret.
export const X_CALLBACK = DEV_ORIGIN + "/api/connections/x/callback";
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
export const X_STATE_COOKIE = "elettro_dev_x_state";
// Every brand can have an X account; `google-review` is the isolated demo brand for Google's reviewer.
export const X_BRANDS: string[] = brandConfigs.map((b) => b.id).filter((id) => id !== "google-review");
// Posts are 280 characters (a link counts as 23); X refuses a longer one with a clear message.
export const X_POST_LIMIT = 280;
export const X_TOKEN_PREFIX = "elettro-brand-os-dev/x/";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

export type XApp = { clientId: string; clientSecret: string };
export type XAccountTokens = {
  accessToken: string; refreshToken: string | null; expiresAt: string | null; scope: string | null;
  accountId: string; username: string; brand: string; connectedAt?: string;
};

export async function xApp(): Promise<XApp> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/x-oauth" }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}");
  if (!clientId || !clientSecret) throw Error("X app is not set up");
  return { clientId, clientSecret };
}

export function xBasicAuth(app: XApp) {
  return "Basic " + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
}

// A valid access token for the account: reuse the saved one while it has over a minute left, otherwise refresh
// and save the rotated pair (the old refresh token stops working the moment X issues the new one).
export async function freshXToken(secretName: string, saved: XAccountTokens): Promise<string> {
  const left = saved.expiresAt ? Date.parse(saved.expiresAt) - Date.now() : 0;
  if (saved.accessToken && left > 60_000) return saved.accessToken;
  if (!saved.refreshToken) throw Error("X login expired; reconnect X");
  const app = await xApp();
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: xBasicAuth(app) },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: app.clientId }),
    cache: "no-store"
  });
  const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || !token.access_token) throw Error(`X login expired; reconnect X (${token.error_description || token.error || response.status})`);
  const next: XAccountTokens = {
    ...saved, accessToken: token.access_token, refreshToken: token.refresh_token || saved.refreshToken,
    expiresAt: new Date(Date.now() + (token.expires_in || 7200) * 1000).toISOString(), scope: token.scope || saved.scope
  };
  await secrets.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: JSON.stringify(next) }));
  return next.accessToken;
}
