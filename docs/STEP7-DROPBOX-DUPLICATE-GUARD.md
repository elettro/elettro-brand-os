# Step 7: Global Dropbox ID lookup and collision audit

Status: **code prepared on `develop`, GitHub CI passed; not deployed or live-tested against AWS DEV Lambda** as of the Step 7 package build.

## Goal

Protect a multi-brand Elettro Publishing Engine library when the registry grows beyond the current `GET /assets` response limit of 500 records. Dropbox file identity is **the immutable Dropbox file ID**, not its filename or folder path. Both the existing dashboard and the future Claude/ChatGPT integrations must share one registry without accidental duplicate registrations.

There are two legitimate registry field conventions:

- **Direct dashboard Dropbox upload**: `Asset.sourceExternalId` (Dropbox ID) and `Asset.sourceUrl` (path).
- **Dropbox sync**: `Asset.sourceFileId` (Dropbox ID) and `Asset.sourcePath` (path).

New global ID lookup must recognize BOTH formats and detect cross-brand or archived/retired collisions.

## Step 7A: Read-only DEV Lambda lookup (prepared)

Existing API route `GET /assets` now has an optional `dropboxFileId` query parameter and requires a known `brandSlug`.

```text
GET /assets?brandSlug=stashbox&dropboxFileId=id%3AUM9GhyUcVDgAAAAAAAMB-g
```

This branch performs **a database-wide SELECT**, not the old 500-row browse query, matching either `sourceExternalId` or `sourceFileId` across all brands, including retired records. It returns `lookupVersion:2`, `lookupComplete:true`, `matchCount`, `matches`, and the echoed identifiers. A `COUNT(*) OVER()` reports the actual number of matches even when response rows are limited.

The gateway fails closed when the endpoint is missing/old, a row has conflicting source IDs, multiple rows match the same ID, a matching row is retired, or an existing ID belongs to another brand. **No filename or path match can override a differing immutable Dropbox ID.**

Existing assets with an exact matching Dropbox ID can be reused without invoking registration. **New AI registrations remain disabled** until uniqueness is also enforced transactionally in the database. A full-table lookup alone is not race-safe.

The dashboard's original upload flow is unchanged. The AI Gateway Step 7 Lab action `inspect_global_dropbox_id` uses the database alone: no Dropbox OAuth round trip, no registration, no asset changes. The same read-only action is exposed to Claude and ChatGPT in the shared MCP catalog, but the assistants are not yet connected.

## Step 7B: Read-only global collision audit (prepared)

A direct Lambda test invocation with:

```json
{ "action": "audit-dropbox-ids" }
```

returns:

- `dropboxAssets`: count of all Dropbox-source asset records, including retired.
- `duplicateDropboxIds`: number of Dropbox IDs represented by more than one asset ID (checks BOTH source columns).
- `conflictingSourceIds`: number of individual asset records whose two non-null Dropbox ID fields disagree.
- `missingSourceIds`: number of Dropbox-source asset records without an ID in either field.

This is an aggregate, read-only audit. **Do not claim zero duplicates until it is actually executed against the live DEV database.** Do not backfill by filename.

## Step 7C: DEV deployment procedure

The user previously deployed the working Lambda `elettro-brand-os-dev-api` with PATCH2. The uploaded PATCH2 package is the patch base for a new **read-only** PATCH3 artifact.

Expected original AWS Lambda `Code SHA-256` (PATCH2):

```text
9yUq0+Hx38x9sbEvdL/SwjCIvr1fDD1nTi1IAKqMOBE=
```

Expected PATCH3 `Code SHA-256`:

```text
kbLgUThwVLpK+tf9tXkMu78L28LZiXQaPuMdy2t7Lew=
```

PATCH3 was constructed from the owner's previously uploaded and deployed PATCH2 ZIP. Only `db-main.mjs` was changed; all 3,648 ZIP entries remain, `index.mjs` including its working `complete-dropbox-upload` handler is unchanged, and JavaScript syntax plus ZIP integrity were verified. The patched module's Git blob hash exactly matches `develop` (`b0ebbfd0496930150c14d099bfcad29cdce31e60`). The GitHub Lambda workflow packages a ZIP but **does not deploy AWS Lambda**.

**Before upload**: confirm the active DEV Lambda SHA is still PATCH2. If not, stop; download and inspect the newer live package. Never overwrite newer code blindly.

Once approved, upload the PATCH3 ZIP to **AWS Lambda `elettro-brand-os-dev-api` in `us-east-1`**. Retain the previous PATCH2 ZIP for rollback. No production Lambda or Stock Gallery operations are part of this step.

Test a known Stashbox video by direct Lambda **Test** event (read-only):

```json
{
  "action": "assets",
  "queryStringParameters": {
    "brandSlug": "stashbox",
    "dropboxFileId": "id:UM9GhyUcVDgAAAAAAAMB-g"
  }
}
```

Expected: HTTP 200; `lookupComplete:true`, `lookupVersion:2`, `matchCount:1`, a record with `id:"08adc79a-211e-4f9a-9ebe-da2614285dad"`, and `brandSlug:"stashbox"`. If another count or record appears, stop and investigate before any write work.

Then run the read-only audit event above and record its counts.

After Amplify `develop` successfully deploys the latest web commit, use the existing AI Gateway Lab: Stashbox → search `SE53F9~1.MP4` → Step 7 **Verify Dropbox ID across all assets (read-only)**. A genuine PASS requires `globalLookupVerified:true` and `lookupScope:"all_registered_assets"`. No Step 5 Dropbox-auth check is required first for this new button.

## Step 7D: Database-enforced global uniqueness (NOT YET APPROVED OR DEPLOYED)

**Do not enable new AI registrations or create a unique index automatically.** First obtain the live aggregate audit results and inspect collision causes. Then review *all* registration/ingestion writers, including:
- Direct dashboard registration in the currently deployed `completeDropboxUpload` function (currently matches `sourceExternalId`).
- Dropbox sync ingestion (currently matches `sourceFileId`).
- Any background worker or migrated sources writing either field.

Before enabling a canonical unique index, those writers must agree on the same identity across both columns. Otherwise a new index could cause uploads or sync to fail on formerly duplicated records. A canonical expression index and a constraint forbidding conflicting IDs may be appropriate **after** resolving existing collisions and verifying the active writers. A separate transaction-safe migration, rollback plan, owner approval, and DEV acceptance test are required.

A supporting NON-unique index on `(sourceType, sourceFileId)` has been added to checked-in `init.sql` and Prisma schema, but **no live DB migration has run**. This optimization is separate from canonical unique enforcement.

### Completion gates

- Metadata write+restore: **PASS** (Step 4).
- Stashbox Dropbox ID/path: **PASS** (Step 5).
- Existing file registration preflight: **PASS** (Step 6; no registration writes).
- Global ID lookup and collision audit: **coded and ZIP validated; live acceptance pending**.
- Canonical uniqueness + real new-file/repeated-registration write test: **pending audit and schema migration**.
- ChatGPT and Claude connections: **not provisioned**.
- Stock Galleries: **paused**.


## October 13, 2026 — Live DEV audit result: CLEAN

Owner deployed PATCH3 to AWS Lambda `elettro-brand-os-dev-api`. Code SHA-256 on Lambda run: `kbLgUThwVLpK+tf9tXkMu78L28LZiXQaPuMdy2t7Lew=`. The first direct read-only Lambda Test of the global lookup returned:
- `lookupComplete:true`, `lookupVersion:2`, `matchCount:1`;
- Stashbox asset `08adc79a-211e-4f9a-9ebe-da2614285dad`, Dropbox ID `id:UM9GhyUcVDgAAAAAAAMB-g`;
- Original asset remained `ready / approved`.

The second live read-only Lambda Test event `{"action":"audit-dropbox-ids"}` returned HTTP 200:
- `dropboxAssets:419`;
- `missingSourceIds:0`;
- `conflictingSourceIds:0`;
- `duplicateDropboxIds:0`.

**Interpretation:** The 419 Dropbox-source records have no duplicate, missing-null, or conflicting paired IDs *according to this audit at test time*. This does NOT enforce future uniqueness, establish full format validation (e.g. blank/invalid IDs), guarantee race safety, or certify a registration write. Re-run audit immediately before any migration.

### Discovered writer compatibility concerns

- The checked-in DEV Lambda `db-main.mjs` Dropbox sync writer selects existing assets by `brandId + sourceFileId` and can insert a new `sourceFileId` row without checking `sourceExternalId`.
- The checked-in `index.mjs` also contains an older Dropbox sync writer. **Do not replace the LIVE `index.mjs` from the repo**: the real live Lambda ZIP has newer direct-Dropbox upload handlers that are absent from the checked-in `index.mjs`.
- The live direct-Dropbox upload writer stores `sourceExternalId` and `sourceUrl` and had been confirmed working with PATCH2/3.
- Source IDs should remain authoritative across moves, and uniqueness must cover BOTH columns **across every brand** (including retired records), not just `(brandId, sourceExternalId)`.

### Proposed non-applied Postgres integrity gate

**Do not execute until owner authorizes it and the live upload/sync writers have been inspected for uniqueness-conflict handling, rollback, and safe atomic update/insert behavior.**

Suggested order:
1. Read-only extended validation: confirm all non-null Dropbox IDs start with `id:`, are nonblank, no pair of non-null IDs in the same row disagrees, and no cross-column duplicate exists across the full registry. The previous audit checks duplicate, missing/null and conflicting ID counts, but **not** ID format or blanks.
2. Verify **all live writers**, not merely GitHub code, gracefully interpret duplicate-key conflicts as a re-use/read-existing outcome. Sync should update an existing matching row by either source ID instead of trying to create a second record. If a different brand owns the file ID, **block and flag it** rather than silently moving ownership.
3. Add a conditional **CHECK** on Dropbox-source rows ensuring `sourceFileId` and `sourceExternalId` are not contradictory and the canonical source ID is nonblank and `id:`-prefixed. Confirm every existing row passes before validation.
4. Add a **unique expression index** on the canonical ID (e.g. `COALESCE("sourceExternalId","sourceFileId")`) for `"sourceType"='dropbox'`, covering all brands and both writer formats. Consider `CREATE UNIQUE INDEX CONCURRENTLY` as a standalone migration operation to minimize write blocking. A unique expression index must not be assumed convertible into a simple table `UNIQUE` constraint. If a concurrent build fails, inspect/remove the invalid index safely and re-audit before retrying.
5. Confirm direct dashboard uploads and Dropbox sync still function, then test a disposable new asset + repeat registration only with explicit consent. Verify Ready/Approved assets do not become Raw. No Stock Gallery action.

**Rationale:** A read-then-insert dedup check alone can race; the DB needs the final say. Merely adding unique indexes separately to `sourceExternalId` and `sourceFileId` would NOT prevent two different rows using the same Dropbox ID in opposite columns.

### DEV rollout gate

The Step 7 **read-only dashboard** test is still pending user execution after the latest Amplify develop build. The button is `Verify Dropbox ID across all assets (read-only)` in `/ai-gateway`; it does NOT request a Dropbox OAuth token.

No RDS schema migration has been run. No new AI registration path has been opened.
