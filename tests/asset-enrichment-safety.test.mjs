import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("metadata-only assistant edits preserve ingest, enrichment and approval", () => {
  const gateway = file("apps/web/lib/ai-gateway.ts");
  const lambda = file("services/dev-api-lambda/index.mjs");
  const smoke = file("apps/web/lib/ai-gateway-write-test.ts");
  assert.match(gateway, /preserveWorkflowState: true/);
  assert.match(gateway, /after\.ingestStatus !== before\.ingestStatus/);
  assert.match(gateway, /after\.enrichmentStatus !== before\.enrichmentStatus/);
  assert.match(gateway, /after\.approvalStatus !== before\.approvalStatus/);
  assert.match(lambda, /if \(body\.preserveWorkflowState !== true\)/);
  assert.match(smoke, /stored\.enrichmentStatus===before\.enrichmentStatus/);
  assert.match(smoke, /after\.enrichmentStatus===before\.enrichmentStatus/);
});

test("Dropbox rediscovery and folder-hints backfill do not mutate ingest state", () => {
  const lambda = file("services/dev-api-lambda/index.mjs");
  const backfill = lambda.split("async function backfillFolderHints")[1].split("function normalizeBulkMetadata")[0];
  const sync = lambda.split("async function ingestDropboxPage")[1].split("async function ")[0];
  assert.doesNotMatch(backfill, /"ingestStatus"\s*=/);
  assert.doesNotMatch(sync, /"ingestStatus"\s*=\s*CASE WHEN/);
  assert.match(backfill, /CASE WHEN "enrichmentStatus" = 'pending'/);
  assert.match(sync, /CASE WHEN "enrichmentStatus" = 'pending'/);
});

test("AI enrichment is owner-only, gated, non-destructive and scoped to brand root", () => {
  const helper = file("apps/web/lib/asset-ai-enrichment.ts");
  const route = file("apps/web/app/api/assets/auto-enrich/route.ts");
  const intake = file("apps/web/app/assets/add/intake-client.tsx");
  assert.match(helper, /EPE_AUTO_ENRICH_ENABLED !== "true"/);
  assert.match(helper, /EPE_BEDROCK_VISION_MODEL_ID/);
  assert.match(helper, /!asset\.title\?\.trim\(\)/);
  assert.match(helper, /!asset\.tags\?\.length/);
  assert.match(helper, /latest\.sourcePath !== path/);
  assert.match(helper, /update_asset_metadata/);
  assert.match(route, /await authenticated\(\)/);
  assert.match(route, /request\.headers\.get\("origin"\) !== DEV_ORIGIN/);
  assert.match(intake, /NEXT_PUBLIC_EPE_AUTO_ENRICH_ENABLED === "true"/);
  assert.match(intake, /report\.registered\+\+;/);
  assert.match(intake, /auto-enrich/);
});
