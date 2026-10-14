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
