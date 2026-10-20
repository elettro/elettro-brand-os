import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// TikTok worker for Elettro OS. Runs outside the VPC (it needs open.tiktokapis.com) and is only
// invoked directly through IAM: no HTTP route points at it. Two ways in:
//   an EventBridge schedule (every 6 hours)  renew access tokens that expire within 12 hours
//   { action: "refresh" }                     the same, on demand
// TikTok access tokens last 24 hours; the 365-day refresh token renews them, and each refresh
// can hand back a new refresh token, so the whole token record is rewritten every time.

const secrets = new SecretsManagerClient({});
const APP_SECRET = process.env.TIKTOK_OAUTH_SECRET_NAME || "elettro-brand-os-dev/tiktok-oauth";
const TOKEN_PREFIX = process.env.TIKTOK_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/tiktok/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
// Renew when less than this is left; with a 6-hour schedule every token gets two tries.
const RENEW_WITHIN_MS = 12 * 3600 * 1000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

export function needsRefresh(record, now = new Date()) {
  const expires = Date.parse(record?.accessExpiresAt || "");
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

// Fallbacks match TikTok's documented lifetimes when a response leaves them out.
function at(now, seconds, fallback) {
  const s = Number(seconds);
  return new Date(now.getTime() + (Number.isFinite(s) && s > 0 ? s : fallback) * 1000).toISOString();
}

export async function refreshRecord(record, app, now = new Date(), post = fetch) {
  if (!record?.refreshToken) throw new Error("no refresh token stored");
  const response = await post(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: app.clientKey, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: record.refreshToken
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`TikTok refresh failed: ${body.error_description || body.error || response.status}`);
  }
  return {
    ...record,
    accessToken: body.access_token,
    accessExpiresAt: at(now, body.expires_in, 86_400),
    refreshToken: body.refresh_token || record.refreshToken,
    refreshExpiresAt: body.refresh_token ? at(now, body.refresh_expires_in, 31_536_000) : record.refreshExpiresAt,
    scope: body.scope || record.scope,
    refreshedAt: now.toISOString()
  };
}

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function tokenSecretNames() {
  const names = [];
  let NextToken;
  do {
    const page = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }], NextToken }));
    for (const s of page.SecretList || []) if (s.Name?.startsWith(TOKEN_PREFIX)) names.push(s.Name);
    NextToken = page.NextToken;
  } while (NextToken);
  return names;
}

export async function refreshAll(now = new Date()) {
  const app = await secretJson(APP_SECRET);
  if (!app.clientKey || !app.clientSecret) throw new Error(`${APP_SECRET} needs "clientKey" and "clientSecret"`);
  const accounts = [];
  for (const SecretId of await tokenSecretNames()) {
    const record = await secretJson(SecretId);
    const handle = record.username ? "@" + record.username : record.openId;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, accessExpiresAt: record.accessExpiresAt }); continue; }
    try {
      const next = await refreshRecord(record, app, now);
      await secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(next) }));
      accounts.push({ handle, refreshed: true, accessExpiresAt: next.accessExpiresAt });
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("TikTok refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("TikTok refresh", JSON.stringify(summary));
  return summary;
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("TikTok refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
