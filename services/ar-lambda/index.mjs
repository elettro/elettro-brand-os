/**
 * Elettro AR admin API (elettro-ar-dev-api). Lambda Function URL, outside the VPC, no Postgres access.
 * Environment:
 *   AR_TABLE                    DynamoDB table (elettro-ar-dev)
 *   AR_BUCKET                   private media bucket (elettro-ar-dev-media)
 *   AR_DISTRIBUTION_ID          CloudFront distribution for ar.elettro.com (optional until it exists)
 *   AR_PUBLIC_BASE_URL          https://ar.elettro.com
 *   CONNECTIONS_API_SHARED_SECRET the shared connect key (same value as the dev-api)
 */
import { createApp } from "./app.mjs";
import { createCdn, createDynamoStore, createFiles } from "./adapters.mjs";

let app;

async function build() {
  const { AR_TABLE, AR_BUCKET, AR_DISTRIBUTION_ID, AR_PUBLIC_BASE_URL } = process.env;
  if (!AR_TABLE || !AR_BUCKET) throw new Error("AR_TABLE and AR_BUCKET must be set");
  return createApp({
    store: await createDynamoStore({ table: AR_TABLE }),
    files: await createFiles({ bucket: AR_BUCKET }),
    cdn: await createCdn({ distributionId: AR_DISTRIBUTION_ID }),
    config: { publicBaseUrl: AR_PUBLIC_BASE_URL || "https://ar.elettro.com" }
  });
}

export const handler = async (event) => {
  try {
    app ||= await build();
  } catch (e) {
    console.error("ar-api startup error", e);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: "AR API is not configured" }) };
  }
  return app.handle(event);
};
