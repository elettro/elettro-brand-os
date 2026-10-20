import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Threads worker for Elettro OS. Runs outside the VPC (it needs graph.threads.net) and is only
// invoked directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (once a day)   the tick: renew tokens with less than 30 days left
//   { action: "refresh" }                  the same, on demand
// Threads has no refresh token: the 60-day access token renews itself (th_refresh_token) once it
// is at least 24 hours old and not yet expired, so a missed window means reconnecting by hand.
// After a renewal the dev API moves the account's reconnect countdown (set-token-expiry).

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the app secret (elettro-brand-os-dev/threads-oauth) out of the list.
const TOKEN_PREFIX = process.env.THREADS_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/threads/";
const REFRESH_URL = "https://graph.threads.net/refresh_access_token";
// A daily schedule gives every token about 30 tries before it expires.
const RENEW_WITHIN_MS = 30 * 86_400_000;
// Threads refuses to renew a token younger than 24 hours.
const MIN_AGE_MS = 86_400_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

export function needsRefresh(record, now = new Date()) {
  const expires = Date.parse(record?.expiresAt || "");
  if (Number.isFinite(expires) && expires <= now.getTime()) return false;
  const issued = Date.parse(record?.refreshedAt || record?.connectedAt || "");
  if (Number.isFinite(issued) && now.getTime() - issued < MIN_AGE_MS) return false;
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

export async function refreshRecord(record, now = new Date(), get = fetch) {
  if (!record?.accessToken) throw new Error("no access token stored");
  const url = new URL(REFRESH_URL);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", record.accessToken);
  const response = await get(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || !body.access_token) {
    throw new Error(`Threads refresh failed: ${body.error?.message || response.status}`);
  }
  const seconds = Number(body.expires_in);
  // Threads documents 60 days; fall back to that when the response leaves it out.
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 60 * 86_400;
  return {
    ...record,
    accessToken: body.access_token,
    expiresAt: new Date(now.getTime() + lifetime * 1000).toISOString(),
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

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

export async function refreshAll(now = new Date(), deps = {}) {
  const { names = tokenSecretNames, read = secretJson, write = (SecretId, record) =>
    secrets.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(record) })), refresh = refreshRecord, callApi = api } = deps;
  const accounts = [];
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    const handle = record.username ? "@" + record.username : record.userId;
    if (!needsRefresh(record, now)) { accounts.push({ handle, refreshed: false, expiresAt: record.expiresAt }); continue; }
    try {
      const next = await refresh(record, now);
      await write(SecretId, next);
      const entry = { handle, refreshed: true, expiresAt: next.expiresAt };
      // The token is safe once written; a stale countdown is only cosmetic, so report it and carry on.
      const moved = await callApi({ action: "set-token-expiry", destination: "threads", externalAccountId: record.userId, tokenExpiresAt: next.expiresAt })
        .catch((error) => ({ ok: false, error: error?.message }));
      if (!moved.ok) entry.countdownError = moved.error || "set-token-expiry failed";
      accounts.push(entry);
    } catch (error) {
      // One revoked account must not stop the others; the brand reconnects from /connections.
      console.error("Threads refresh failed:", handle, error?.message);
      accounts.push({ handle, refreshed: false, error: error?.message || "Refresh failed" });
    }
  }
  const summary = { ok: accounts.every((a) => !a.error), accounts };
  console.log("Threads refresh", JSON.stringify(summary));
  return summary;
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick" || event.action === "refresh") {
    try { return result(200, await refreshAll()); } catch (error) {
      console.error("Threads refresh run failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Refresh failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
