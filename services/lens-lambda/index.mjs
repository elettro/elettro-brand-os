/**
 * Elettro Lens admin API (elettro-lens-dev-api). Lambda Function URL, outside the VPC, no Postgres access.
 * Environment:
 *   LENS_TABLE                    DynamoDB table (elettro-lens-dev)
 *   LENS_BUCKET                   private media bucket (elettro-lens-dev-media)
 *   LENS_DISTRIBUTION_ID          CloudFront distribution for lens.elettro.com (optional until it exists)
 *   LENS_PUBLIC_BASE_URL          https://lens.elettro.com
 *   CONNECTIONS_API_SHARED_SECRET the shared connect key (same value as the dev-api)
 */
import { createApp } from "./app.mjs";
import { createCdn, createDynamoStore, createFiles } from "./adapters.mjs";

let app;

async function build() {
  const { LENS_TABLE, LENS_BUCKET, LENS_DISTRIBUTION_ID, LENS_PUBLIC_BASE_URL } = process.env;
  if (!LENS_TABLE || !LENS_BUCKET) throw new Error("LENS_TABLE and LENS_BUCKET must be set");
  return createApp({
    store: await createDynamoStore({ table: LENS_TABLE }),
    files: await createFiles({ bucket: LENS_BUCKET }),
    cdn: await createCdn({ distributionId: LENS_DISTRIBUTION_ID }),
    config: { publicBaseUrl: LENS_PUBLIC_BASE_URL || "https://lens.elettro.com" }
  });
}

export const handler = async (event) => {
  try {
    app ||= await build();
  } catch (e) {
    console.error("lens-api startup error", e);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: "Lens API is not configured" }) };
  }
  return app.handle(event);
};
