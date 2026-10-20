import { NextRequest } from "next/server";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { THREADS_OAUTH_SECRET, verifySignedRequest } from "@/lib/threads-connect";

const secrets = new SecretsManagerClient({ region: "us-east-1" });

// Shared by the uninstall and delete callbacks: Meta POSTs a form with signed_request; null when it does not verify.
export async function threadsSignedRequest(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const signed = String(form?.get("signed_request") || "");
  if (!signed) return null;
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: THREADS_OAUTH_SECRET }));
  const { clientSecret } = JSON.parse(secret.SecretString || "{}") as { clientSecret?: string };
  return verifySignedRequest(signed, clientSecret || "");
}
