# Dropbox brand-content migration — runbook (2026-10-17)

## Desired layout

- `/1---elettro-brand-os/brands/{brand}/`: brand media (six brands)
- `/1---elettro-brand-os/creative-assets/`: shared stock media, **unchanged**
- `/1---elettro-brand-os/intelligence/`: brand and platform editorial knowledge, **unchanged**

## Current Dropbox state (verified 2026-10-17, read-only)

The `brands/{brand}` trees are **copies**, not moves. The originals at `/1---elettro-brand-os/{brand}` are untouched and remain the rollback copy until deletion is separately authorized. Copies have **new Dropbox file IDs**, so changing root paths alone would orphan every registered asset and make the next sync insert 276 duplicates.

| brand | files | folders | bytes | source root id | copy root id |
|---|---|---|---|---|---|
| stashbox | 251 | 141 | 19,583,596,647 | `id:UM9GhyUcVDgAAAAAAAL2jg` | `id:UM9GhyUcVDgAAAAAAAMFAg` |
| elettro | 25 | 11 | 105,042,151 | `id:UM9GhyUcVDgAAAAAAAL2kg` | `id:UM9GhyUcVDgAAAAAAAMGiw` |
| solarmeister / neckermann-strom / weightlossdavie / therasbox | 0 | 0 | 0 | (empty, both sides) | |

`scripts/build-dropbox-brand-id-map-20261017.py` pairs every source file to exactly one copy by relative path + `content_hash` + size and fails closed otherwise: **276/276 matched, 0 failures**.

## What deploys where (GitHub Actions only *builds* ZIPs; nothing is auto-deployed)

| AWS function | source | why it must deploy |
|---|---|---|
| `elettro-brand-os-dev-api` | `services/dev-api-lambda` | new roots, ID-aware migration action, ingest cutover gate |
| `elettro-brand-os-dev-dropbox-sync` | `services/dropbox-sync-lambda` | folder relay brand root |
| `elettro-brand-os-dev-dropbox-upload` | `services/dropbox-upload-lambda` (imported from the deployed ZIP) | large-upload root check; otherwise every chunked upload to `brands/` is rejected |
| Amplify `d2k28tehm1a8zw` develop | `apps/web` | browser/intake/MCP paths |

The deployed API/sync Lambdas (2026-10-14) ran the unmerged `fix-claude-folder-network-20261014` relay; this branch merges it so deploying does not regress Claude folder operations.

## Safety properties

- Ingest indexes a file only if it lies under the brand's root **as registered in the database**. Before the DB migration, roots are old, so `brands/` copies are skipped; after it, the old originals are skipped. Code can therefore be deployed before the data cutover without creating duplicates.
- Ingest matches existing assets by `sourceFileId` **or** `sourceExternalId`, so direct-uploaded assets are not re-inserted.
- The `migrate-dropbox-brand-roots-20261017` action (IAM direct invoke only; HTTP/MCP rejected) runs in one transaction with table locks: validates the mapping, rewrites only `sourceFileId`, `sourceExternalId`, `sourcePath`, `sourcePathLower`, `sourceUrl` (path form) and `sourceMetadata` id/path/rev keys; keeps `Asset.id`, statuses, tags, notes, ledger links and `storageRootId`; updates the six `BrandStorageRoot` rows in place; clears the sync cursor. It refuses on duplicate/mixed/cross-brand IDs or unexpected roots, then re-checks inside the transaction that no source ID remains, no copy ID is shared, and per-brand counts/status/metadata fingerprints are unchanged. Defaults to dry run (rolled back).
- Backups: first-touch copies of affected `Asset`, `BrandStorageRoot`, `StorageConnection` rows in `_mig_dropbox_brand_roots_20261017_*` tables, plus a per-asset audit table. Historical assets with unavailable source IDs are reported (`unmappedOldRootAssets`), never rematched by filename.

## Cutover (DEV) — requires a deploy-capable AWS identity

```bash
export AWS_REGION=us-east-1
# 0. Snapshot
aws rds create-db-snapshot --db-instance-identifier elettro-brand-os-dev --db-snapshot-identifier ebos-dev-pre-brands-20261017
# 1. Record current code for rollback
for f in elettro-brand-os-dev-api elettro-brand-os-dev-dropbox-sync elettro-brand-os-dev-dropbox-upload; do
  aws lambda publish-version --function-name $f --description pre-brands-20261017; done
# 2. Deploy the three ZIPs built from this branch's merge commit, then verify CodeSha256
aws lambda update-function-code --function-name elettro-brand-os-dev-api --zip-file fileb://elettro-brand-os-dev-api.zip --publish
aws lambda update-function-code --function-name elettro-brand-os-dev-dropbox-sync --zip-file fileb://elettro-brand-os-dev-dropbox-sync.zip --publish
aws lambda update-function-code --function-name elettro-brand-os-dev-dropbox-upload --zip-file fileb://elettro-brand-os-dev-dropbox-upload.zip --publish
# 3. Build mapping (read-only) and wrap it as the invoke payload
python scripts/build-dropbox-brand-id-map-20261017.py secret.json map.json
python -c "import json;m=json.load(open('map.json'));json.dump({'action':'migrate-dropbox-brand-roots-20261017','mode':'dry-run','expectedMappedFiles':276,'mapping':m['mapping']},open('dry.json','w'))"
aws lambda invoke --function-name elettro-brand-os-dev-api --payload fileb://dry.json dry-out.json   # must be ok:true, failures:[]
# 4. Same payload with "mode":"apply"
# 5. Trigger a full Dropbox sync; then run the verification list below
```

## Verification

`elettro_list_brand_folders` reports `/1---elettro-brand-os/brands/{slug}` for all six; every mapped asset resolves by copy ID (`elettro_verify_global_dropbox_id`); asset count/status fingerprints match the dry-run `before`; no copy ID has two assets; folder browse, folder create, upload (small + chunked) and duplicate detection work per brand; ChatGPT and Claude MCP connectivity.

## Rollback

1. `aws lambda update-function-code` each function back to the `pre-brands-20261017` published version's code (or update alias).
2. Invoke the API Lambda with `{"action":"migrate-dropbox-brand-roots-20261017","mode":"rollback"}`: restores only the columns the migration wrote (later approvals/edits survive), restores roots, clears cursor.
3. Full sync. Originals were never touched. Last resort: restore the RDS snapshot.

Production is a separate, later approval.
