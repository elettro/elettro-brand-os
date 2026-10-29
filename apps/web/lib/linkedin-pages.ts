import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DEV_ORIGIN, serverSetting } from "@/lib/cognito-auth";
import { LINKEDIN_API_VERSION, LINKEDIN_CALLBACK, LINKEDIN_PAGES_SECRET_ID } from "@/lib/linkedin-connect";

// LinkedIn calls for company pages. They happen in the web app because the dev-api Lambda has no internet egress.
const secrets = new SecretsManagerClient({ region: "us-east-1" });
const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

export type PageToken = { accessToken: string; expiresIn?: number; refreshToken?: string; refreshExpiresIn?: number; scope?: string };
export type AdminPage = { id: string; name: string };

export async function pagesTokenFor(code: string): Promise<PageToken> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: LINKEDIN_PAGES_SECRET_ID }));
  const { clientId, clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientId?: string; clientSecret?: string };
  if (!clientId || !clientSecret) throw Error("LinkedIn: the company-page app secret is not stored yet");
  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: LINKEDIN_CALLBACK, client_id: clientId, client_secret: clientSecret }),
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({})) as {
    access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string; error?: string; error_description?: string;
  };
  if (!response.ok || !body.access_token) throw Error(`LinkedIn rejected the code: ${body.error_description || body.error || response.status}`);
  return { accessToken: body.access_token, expiresIn: body.expires_in, refreshToken: body.refresh_token, refreshExpiresIn: body.refresh_token_expires_in, scope: body.scope };
}

const restHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
  "linkedin-version": LINKEDIN_API_VERSION,
  "x-restli-protocol-version": "2.0.0"
});

// The company pages this login administers (approved administrators only), with their names.
export async function adminPages(accessToken: string): Promise<AdminPage[]> {
  const acls = await fetch("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED", {
    headers: restHeaders(accessToken), cache: "no-store"
  });
  const body = await acls.json().catch(() => ({})) as { elements?: Array<{ organization?: string }>; message?: string };
  if (!acls.ok) throw Error(`LinkedIn page lookup failed: ${body.message || acls.status}`);
  const ids = [...new Set((body.elements || []).map((e) => /^urn:li:organization:(\d+)$/.exec(e.organization || "")?.[1]).filter((id): id is string => !!id))];
  return Promise.all(ids.map(async (id) => {
    const org = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, { headers: restHeaders(accessToken), cache: "no-store" });
    const detail = await org.json().catch(() => ({})) as { localizedName?: string };
    return { id, name: detail.localizedName || `LinkedIn page ${id}` };
  }));
}

// Hands the page and its tokens to the dev-api, which stores them and links the brand's LinkedIn account.
export async function completePageConnect(brand: string, page: AdminPage, token: PageToken) {
  const key = await serverSetting("CONNECTIONS_API_SHARED_SECRET");
  const response = await fetch(`${apiBaseUrl}/connections/linkedin/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-elettro-connect-key": key },
    body: JSON.stringify({
      brand, page, accessToken: token.accessToken, expiresIn: token.expiresIn, scope: token.scope,
      refreshToken: token.refreshToken, refreshExpiresIn: token.refreshExpiresIn
    }),
    cache: "no-store"
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; expiresAt?: string };
  if (!response.ok || !result.ok) throw Error(`LinkedIn ${result.error || `connect failed (HTTP ${response.status})`}`);
  return result;
}

export const connectionsUrl = (params: Record<string, string>) => DEV_ORIGIN + "/connections?" + new URLSearchParams(params) + "#linkedin";
