import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEV_ORIGIN, serverSetting } from "@/lib/cognito-auth";

// Bluesky (AT Protocol) OAuth. There is no developer-portal review: the "app" is the public client-metadata
// document served at BLUESKY_CLIENT_ID, and the ES256 signing key in Secrets Manager (elettro-brand-os-dev/bluesky-oauth,
// key "privateJwk") that proves a token request really comes from Elettro OS.
export const BLUESKY_CLIENT_ID = DEV_ORIGIN + "/api/connections/bluesky/client-metadata";
export const BLUESKY_CALLBACK = DEV_ORIGIN + "/api/connections/bluesky/callback";
export const BLUESKY_JWKS = DEV_ORIGIN + "/api/connections/bluesky/jwks";
// "transition:generic" is the scope that allows creating posts and uploading photos and video.
export const BLUESKY_SCOPE = "atproto transition:generic";
export const BLUESKY_OAUTH_SECRET = "elettro-brand-os-dev/bluesky-oauth";
export const BLUESKY_STATE_COOKIE = "elettro_dev_bluesky_state";
// Same brands as Threads for now; each connects its own Bluesky account.
export const BLUESKY_BRANDS = ["stashbox", "elettro", "therasbox", "solarmeister", "weightlossdavie"];
// Blank handle: Bluesky's own sign-in page asks which account.
export const BLUESKY_ENTRYWAY = "https://bsky.social";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

async function signingKey() {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: BLUESKY_OAUTH_SECRET }));
  const { privateJwk } = JSON.parse(secret.SecretString || "{}") as { privateJwk?: string | Record<string, unknown> };
  if (!privateJwk) throw Error(`Bluesky signing key missing: ${BLUESKY_OAUTH_SECRET} needs a "privateJwk" key`);
  return JoseKey.fromImportable(typeof privateJwk === "string" ? privateJwk : JSON.stringify(privateJwk));
}

/**
 * The OAuth client plus the two things it saves. A request is short-lived, so the "state" the library keeps
 * between authorize and callback is held in `states` (the start route seals it into a cookie, the callback
 * route puts it back), and the finished login is captured in `sessions` for the caller to send to the dev-api.
 */
export async function blueskyClient(states: Map<string, NodeSavedState> = new Map()) {
  const sessions = new Map<string, NodeSavedSession>();
  const key = await signingKey();
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: BLUESKY_CLIENT_ID,
      client_name: "Elettro OS",
      client_uri: DEV_ORIGIN,
      redirect_uris: [BLUESKY_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: BLUESKY_SCOPE,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      application_type: "web",
      dpop_bound_access_tokens: true,
      jwks_uri: BLUESKY_JWKS
    },
    keyset: [key],
    // This client only runs the login; refreshing (and its cross-process lock) belongs to the publisher Lambda.
    requestLock: async (_name, fn) => fn(),
    stateStore: {
      async get(k) { return states.get(k); },
      async set(k, v) { states.set(k, v); },
      async del(k) { states.delete(k); }
    },
    sessionStore: {
      async get(sub) { return sessions.get(sub); },
      async set(sub, v) { sessions.set(sub, v); },
      async del(sub) { sessions.delete(sub); }
    }
  });
  return { client, states, sessions };
}

// The saved login state holds a private DPoP key and the PKCE verifier. The shared cookie seal only signs, so this
// cookie is also encrypted (AES-256-GCM, key derived from the session secret) before it goes to the browser.
export async function encryptState(plain: string): Promise<string> {
  const key = createHash("sha256").update((await serverSetting("ELETTRO_AUTH_SESSION_SECRET")) + "|bluesky-state").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export async function decryptState(input: string | undefined): Promise<string | null> {
  if (!input) return null;
  try {
    const raw = Buffer.from(input, "base64url");
    const key = createHash("sha256").update((await serverSetting("ELETTRO_AUTH_SESSION_SECRET")) + "|bluesky-state").digest();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
