# Step 8 — Permanent Dropbox ID integrity (DESIGN ONLY, NOT DEPLOYED)

## Verified live baseline — October 13, 2026

The owner completed Step 7 in the authenticated DEV dashboard:

```json
{
  "ok": true,
  "brandSlug": "stashbox",
  "assetId": "08adc79a-211e-4f9a-9ebe-da2614285dad",
  "filename": "SE53F9~1.MP4",
  "dropboxFileId": "id:UM9GhyUcVDgAAAAAAAMB-g",
  "globalLookupVerified": true,
  "verificationStatus": "globally_unique_match",
  "lookupVersion": 2,
  "lookupScope": "all_registered_assets",
  "matchingRecords": 1,
  "ingestStatus": "ready",
  "approvalStatus": "approved"
}
```

Direct DEV Lambda audit: `dropboxAssets=419`, `duplicateDropboxIds=0`, `missingSourceIds=0`, `conflictingSourceIds=0`. The audit and dashboard tests were read-only, so **Step 7 is PASS**. The database is not yet protected against future race-condition duplicates.

**DO NOT APPLY THE CONSTRAINTS IN THIS DOCUMENT YET.** This document is a review artifact, not a migration. Explicit owner approval, verified live writer compatibility, current read-only preflight, and backup/rollback strategy are prerequisites. No RDS or Dropbox mutations were performed when producing this plan. Stock Galleries remain paused.

## Actual deployed DEV writer compatibility

Inspected the owner's PATCH3 live-derived Lambda package, not just GitHub:

- **Live `index.mjs` `completeDropboxUpload`:** checks for an existing Dropbox file using `brandId + sourceExternalId`; on new files INSERTs `sourceExternalId` and `sourceUrl`. `ON CONFLICT DO NOTHING` returns 409 when a concurrent duplicate insert loses, rather than returning the existing row. The working direct Dropbox upload logic must be preserved.
- **Live `db-main.mjs` Dropbox ingestion:** checks for an existing Dropbox file using `brandId + sourceFileId` only; on new files INSERTs `sourceFileId` and `sourcePath`. It currently does not consider direct-upload `sourceExternalId`.
- Both writers have a **read-then-insert race** and are currently brand-scoped, so they can fail to identify an asset already registered under another brand.
- The checked-in `services/dev-api-lambda/index.mjs` is **older than the deployed version** and lacks the working direct Dropbox upload implementation; never deploy it wholesale over the live Lambda.
- The DEV Lambda Step 7 global lookup queries `sourceFileId` **or** `sourceExternalId` across all brands and retired rows, but cannot by itself prevent a race.

## Safe rollout in stages

1. **Extended read-only preflight, on the actual DEV RDS DB:** verify source ID format/blank values in addition to the previously checked duplicate/null/conflict counts. Collect a list of impacted asset IDs if any; do not infer Dropbox identity by filename or path. Save a dated audit summary.
2. **Patch and verify both live writer paths** so they resolve an existing asset by immutable Dropbox ID across BOTH columns and all brands, including retired rows. A cross-brand or retired match is a review/block, never reassignment. Matching same-brand assets should be re-used without resetting Ready/Approved. Handle concurrent unique-key conflicts by selecting the existing asset and returning an idempotent response (or a clear review outcome), not by creating a second row. Preserve the original working direct Dropbox upload handlers, and keep a SHA-verified ZIP for rollback.
3. **Define a canonical Dropbox identity** for existing rows: `COALESCE(NULLIF("sourceExternalId", ''), NULLIF("sourceFileId", ''))` for `sourceType='dropbox'`. Reject a Dropbox row when both nonempty IDs disagree. All brands must share the uniqueness domain.
4. **After owner approval and another clean live audit**, install a Postgres CHECK and a global unique partial expression index for the canonical ID. Use a named reversible migration, with an out-of-transaction `CREATE UNIQUE INDEX CONCURRENTLY` only if the chosen migration runner supports it. No publication/eligibility fields are changed.
5. **Acceptance in DEV only:** real new disposable file registration, immediate repeat, simultaneous duplicate request if practical, cross-brand conflict detection, Dropbox sync reuse of same asset, rename/move behavior by stable Dropbox ID, Ready/Approved preservation, and routine dashboard upload regression. None should affect stock files.
6. **Only then** consider allowing new AI registrations and credentialed Claude/ChatGPT access within explicit per-brand scopes.

## Proposed SQL — REVIEW ONLY, NEVER RUN AS A BATCH

### Preflight: read-only extended audit

```sql
WITH source_rows AS (
 SELECT "id", "brandId", "sourceExternalId", "sourceFileId",
        NULLIF("sourceExternalId", '') AS external_id,
        NULLIF("sourceFileId", '') AS file_id
 FROM "Asset" WHERE "sourceType" = 'dropbox'
), ids AS (
 SELECT s."id", k.dropbox_id
 FROM source_rows s
 CROSS JOIN LATERAL (
   SELECT DISTINCT value AS dropbox_id
   FROM unnest(ARRAY[s.external_id, s.file_id]) AS t(value)
   WHERE value IS NOT NULL
 ) k
), collisions AS (
 SELECT dropbox_id, COUNT(DISTINCT "id") AS rows_with_id
 FROM ids GROUP BY dropbox_id HAVING COUNT(DISTINCT "id") > 1
)
SELECT
  (SELECT COUNT(*) FROM source_rows) AS total_dropbox_rows,
  (SELECT COUNT(*) FROM source_rows WHERE external_id IS NULL AND file_id IS NULL)
    AS blank_or_missing_ids,
  (SELECT COUNT(*) FROM source_rows WHERE external_id IS NOT NULL
      AND file_id IS NOT NULL AND external_id <> file_id)
    AS conflicting_ids_on_same_row,
  (SELECT COUNT(*) FROM ids WHERE dropbox_id !~ '^id:[A-Za-z0-9_-]+$')
    AS invalid_formatted_id_occurrences,
  (SELECT COUNT(*) FROM collisions) AS cross_row_duplicate_ids;
```

This supplements, but does not replace, the 419-row live audit. A nonzero result stops the migration.

### Constraint proposal — ONLY after writer upgrades and approved migration

```sql
-- One-time REVIEW ONLY: do not execute from this document.
ALTER TABLE "Asset"
 ADD CONSTRAINT "Asset_dropbox_source_id_integrity_ck"
 CHECK (
   "sourceType" <> 'dropbox'
   OR (
     COALESCE(NULLIF("sourceExternalId", ''), NULLIF("sourceFileId", ''))
       ~ '^id:[A-Za-z0-9_-]+$'
     AND (
       NULLIF("sourceExternalId", '') IS NULL
       OR NULLIF("sourceFileId", '') IS NULL
       OR "sourceExternalId" = "sourceFileId"
     )
   )
 ) NOT VALID;
-- VALIDATE CONSTRAINT in a separately reviewed operation once every row passes.
```

```sql
-- Separate approved operation, outside any transaction wrapper.
CREATE UNIQUE INDEX CONCURRENTLY "Asset_dropbox_canonical_id_unique_idx"
 ON "Asset" ((COALESCE(NULLIF("sourceExternalId", ''), NULLIF("sourceFileId", ''))))
 WHERE "sourceType" = 'dropbox';
```

**Important:** the index must cover *all brands*, not just the selected brand. The CHECK is required for this canonical expression approach: without it, one row could have different values in the two ID columns and evade duplicate detection. The unique index protects old and new rows, including retired records. A failed concurrent build may leave an invalid index requiring carefully reviewed cleanup. Be precise about the real PostgreSQL enum representation when applying the CHECK; the above SQL is an illustrative draft.

### Rollback strategy, only after approval

- Preserve the last-known-good DEV Lambda ZIP, database snapshot, migration SQL and checksum.
- If the writer patch fails, restore the previous DEV Lambda code; do not drop a live unique index blindly while an unpatched writer may be running.
- If a constraint or index blocks legitimate operations, stop ingestion and investigate safely; plan a reversible DB migration and re-audit before resuming.
- Do not move, delete, re-register, or bulk-update any approved asset to 'fix' an identity collision.

## Implementation status

- Step 4 metadata write/restore: PASS.
- Step 5 Dropbox identity: PASS.
- Step 6 existing-registration preflight: PASS.
- Step 7 global lookup and 419-asset collision audit: PASS.
- Step 8 writer compatibility patch / extended audit / unique DB constraint: **NOT DEPLOYED**.
- New AI registrations: DISABLED.
- External ChatGPT / Claude MCP credentials: NOT PROVISIONED.

## Step 8 implementation handoff — prepared October 13–14, 2026

**Status:** The code and migration artifacts are prepared; nothing has been deployed into AWS for Step 8. Production and Stock Galleries remain untouched. The original user's Step 7 `audit-dropbox-ids` returned 419 assets with zero duplicate/missing/conflicting IDs and Step 7 dashboard global-ID verification passed.

### Code staged on `develop`

- `services/dev-api-lambda/dropbox-identity.mjs`: global immutable Dropbox file ID validation, transaction-scoped advisory lock, global lookup across both `sourceFileId` and `sourceExternalId`, two-match collision fail-closed, cross-brand/retired/conflicting-identity fail-closed; no approval/status mutation.
- `services/dev-api-lambda/db-main.mjs`: wraps existing Dropbox sync writer in global ID transaction, preserves existing raw/status update behavior, treats unique conflicts as existing assets only when immutable ID and brand match. Extends read-only `audit-dropbox-ids` to `auditVersion:2`, `invalidSourceIdRows`, `uniquenessIndexValid`, `identityCheckValidated`.
- `tests/dropbox-identity.test.mjs` and CI step cover reuse, source column formats, cross-brand/retired/conflicting IDs, transaction rollback and no-write path.
- **CRITICAL:** The checked-in `services/dev-api-lambda/index.mjs` predates the real working direct Dropbox upload code. **Do not deploy the generic GitHub Lambda build artifact over the live function.**

### Safe live-derived PATCH4 ZIP

Generated from the exact user-confirmed PATCH3 Lambda ZIP deployed in AWS. Only `index.mjs` and `db-main.mjs` differ, plus NEW `dropbox-identity.mjs`; all other **3,646** entries match the live-derived PATCH3 package byte-for-byte. The PATCH4 `index.mjs` patches the working direct Dropbox registration handler and its separate page-ingest path, retaining existing verification, metadata, dropdown and upload code. Both files pass `node --check`. An offline helper test suite passed **18/18**. GitHub CI `d7b0728` passed.

- Expected current AWS Lambda PATCH3 `Code SHA-256`: `kbLgUThwVLpK+tf9tXkMu78L28LZiXQaPuMdy2t7Lew=`.
- PATCH4 `Code SHA-256`: `GzfIJoSxBbk+0eiO5VfIbh255y0vgAZnOVWY8j4ZRWg=`.
- Prepared artifact filename: `elettro-brand-os-dev-api-step8-writer-safety-PATCH4.zip`. Validation report: `elettro-step8-PATCH4-validation.txt`.
- AWS remains on PATCH3 until the owner uploads PATCH4 to DEV; this has **not** happened in the current work.
- No Lambda code update or DB DDL has been performed by the assistant.

### Pre-migration verification

After checking the live Lambda SHA is PATCH3, preserve a backup and deploy **only** the prepared live-derived PATCH4 to DEV (never production). Run direct AWS Lambda Test `{"action":"audit-dropbox-ids"}` and require:
`readOnly:true`, `auditVersion:2`, `duplicateDropboxIds:0`, `missingSourceIds:0`, `conflictingSourceIds:0`, `invalidSourceIdRows:0`. The two constraint status flags will be false until schema enforcement is applied.

A separate **NOT APPLIED** SQL review bundle `elettro-step8-DB-uniqueness-migration-REVIEW.zip` contains:
`01_extended_audit_READ_ONLY.sql`, `02_add_check_AFTER_APPROVAL.sql`, `03_unique_index_AFTER_APPROVAL.sql`, `04_verify_READ_ONLY.sql`, `05_rollback_AFTER_APPROVAL.sql`, and README. The CHECK rejects null/invalid Dropbox IDs and contradictory fields; the partial unique expression index on `COALESCE(sourceExternalId,sourceFileId)` applies across all brands including retired. `CREATE UNIQUE INDEX CONCURRENTLY` must run outside any transaction. Do not execute until explicit owner approval, live writer acceptance, clean extended audit and rollback/snapshot plan.

After both writers and DB index are live and healthy, perform controlled disposable-file registration + repeat, cross-brand rejection, rename/move and Ready/Approved preservation. **New AI registrations stay disabled until that acceptance passes.** ChatGPT and Claude.ai/Claude Code credentials are not yet connected.

## PATCH4 live read-only acceptance — October 14, 2026

Owner uploaded the verified DEV Lambda PATCH4 ZIP. Live Lambda SHA-256: `GzfIJoSxBbk+0eiO5VfIbh255y0vgAZnOVWY8j4ZRWg=`.

The direct Lambda **Test** event `{"action":"audit-dropbox-ids"}` succeeded (HTTP 200) with:
- `ok:true`, `readOnly:true`, `auditVersion:2`
- `dropboxAssets:419`
- `duplicateDropboxIds:0`
- `missingSourceIds:0`
- `conflictingSourceIds:0`
- `invalidSourceIdRows:0`
- `uniquenessIndexValid:false`
- `identityCheckValidated:false`

**Interpretation:** PATCH4 executes correctly against the DEV registry and the read-only data-integrity audit is clean. Database uniqueness and the CHECK constraint are **not yet installed**. Read-only audit success does not prove that the updated upload/sync writers work under mutation or concurrent requests.

**NEXT GATES (not yet completed):**
1. Verify the existing direct-Dropbox dashboard uploader using a harmless disposable asset, including a repeat/same-ID upload; ensure exactly one registry row and that existing Ready/Approved records are not reset.
2. Verify Dropbox discovery/sync correctly reuses a registered direct-upload asset by immutable ID, and that a cross-brand collision is blocked. Use only disposable fixtures and explicit approval.
3. Obtain a current DEV RDS snapshot and confirm a functioning SQL execution path from the VPC. Repeat the extended read-only audit just before any DDL.
4. Obtain explicit approval for the *separate* schema migration. Install and validate the integrity CHECK, then the cross-column partial UNIQUE index outside a transaction. Verify both flags become true and all counts remain zero. Confirm ordinary dashboard uploading still works.
5. Only then consider enabling new AI registration and performing the separate new-file/repeat registration acceptance test.

Do not infer that this test has completed the full Step 8 migration. Do not touch production or Shared Stock Galleries.

## PATCH5 temporary atomic DEV migration (prepared, not deployed)

The owner confirmed that RDS manual snapshot `elettro-brand-os-dev-pre-step8` is **Available / Completed**. PATCH4 (SHA-256 base64 `GzfIJoSxBbk+0eiO5VfIbh255y0vgAZnOVWY8j4ZRWg=`) is deployed and the extended `audit-dropbox-ids` returned 419 Dropbox assets with 0 duplicate, missing, conflicting and invalid IDs; both DB schema flags were false. The owner uploaded one new disposable Raw/Approved Elettro file, confirmed a repeat upload was recognized without saving a second record, and verified a unique DB-wide ID match (`matchingRecords:1`) in the Lab. The snapshot was made after these tests.

**PATCH5 prepared OFFLINE**, without AWS deployment:
- Temporary package `elettro-brand-os-dev-api-step8-atomic-migration-PATCH5.zip` is based on the exact confirmed PATCH4 ZIP and has Code SHA-256 `yjS0CpdwH6mQfGXeDGTd4tEd7gFsRgVjvmDZzuL9/gw=`.
- 3650 ZIP files: the only changed existing file is `index.mjs`; the only added file is `step8-migration.mjs`. All 3648 remaining existing entries are byte-for-byte preserved. Both edited JavaScript files passed Node syntax validation and the ZIP passed CRC. 10/10 local mocked-database tests passed.
- The new direct-Lambda-only action requires exact function name `elettro-brand-os-dev-api`, region `us-east-1`, DEV DB secret, and rejects API Gateway-shaped events. It is not a public API or MCP action.
- `{"action":"step8-migration-preflight"}` re-audits globally across both identity columns, reports uniqueness/check status and `canApply` (read-only).
- Apply event requires explicit `confirmed:true`, `snapshotName:"elettro-brand-os-dev-pre-step8"`, and `expectedTarget:"elettro-brand-os-dev-api"`. It acquires an exclusive Asset table lock **NOWAIT** and performs the full re-audit *inside* a single transaction. A validated CHECK then prevents blank/invalid and contradictory Dropbox IDs; a global partial UNIQUE expression index on `COALESCE("sourceExternalId","sourceFileId")` prevents cross-column duplicates. The index uses ordinary `CREATE UNIQUE INDEX` inside the transaction (rather than concurrent) because this DEV table has ~420 Dropbox rows, and the short exclusive lock provides atomic rollback instead of risking an invalid index. The entire transaction is rolled back if preconditions, DDL or post-DDL verification fail. Other Asset readers/writers may be briefly blocked during this action; lock acquisition fails instead of waiting.
- Verify action `{"action":"step8-migration-verify"}` reports both validity flags and audit results, read-only.
- **After successful verification restore original PATCH4 ZIP** to remove the migration handler while retaining database constraints.
- User-facing operation guide prepared: `/mnt/data/elettro-step8-atomic-migration-RUNBOOK.md`. This path must not be inferred as a sandbox link in a later session; check the file.
- **No database migration has yet been performed by the assistant.** Need owner upload PATCH5 to DEV Lambda, run preflight, review output, then execute explicitly approved apply event, verify, restore PATCH4. Do not expose this via dashboard, production or stock paths.
