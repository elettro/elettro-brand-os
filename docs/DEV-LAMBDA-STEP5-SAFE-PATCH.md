# Elettro Step 5 — Safe DEV Lambda source-ID patch

**Status:** Patch utility prepared in GitHub `develop`. **Not deployed to AWS by a GitHub commit or an Amplify build.**

## Why this is needed

The live AI Gateway Lab Step 5 test on Stashbox `SE53F9~1.MP4` reported:

- `registrationVerified: false`
- `verificationStatus: "source_locator_unavailable"`
- `ingestStatus: "ready"` and `approvalStatus: "approved"`, unchanged.

A separate read-only Dropbox check found the file at:

`/1---elettro-brand-os/stashbox/radio/1x1-promo-videos/1x1-surfing-dean-stashbox-radio/SE53F9~1.MP4`

Dropbox ID: `id:UM9GhyUcVDgAAAAAAAMB-g`.

That **does not prove** which database record owns the Dropbox ID. The checked-in DEV Lambda asset detail SQL selects `sourcePath` but omits `sourceFileId`. The source schema and Dropbox ingestion pipeline persist `sourceFileId`.

## Danger: don't upload the repository ZIP over the Lambda

`.github/workflows/build-dev-api-lambda.yml` **only packages an artifact**. It does NOT deploy it to AWS.

The checked-in Lambda source may be behind the deployed code (the live uploader supports operations not present in the checked-in handler). **Do not replace AWS's current Lambda with the GitHub-generated ZIP.** Doing so can regress the Dropbox upload/registration pipeline.

Instead, use `scripts/patch-live-dev-lambda-source-id.py`. It downloads the **currently deployed** Lambda ZIP directly from AWS, verifies the AWS `CodeSha256`, replaces exactly **one SQL column line** in that package, keeps all other ZIP entries unchanged, and saves the original ZIP for rollback. It refuses unknown ZIP/module/query shapes or ambiguous matches. By default it performs **no AWS writes**.

## Requirements

- AWS CLI authenticated into the correct Elettro DEV AWS account, with read permissions for `lambda:GetFunction` and `lambda:GetFunctionConfiguration` for `elettro-brand-os-dev-api`; apply also requires `lambda:UpdateFunctionCode`.
- Python 3.10+ (uses only the standard library). Node.js is optional for additional syntax checks.
- Up-to-date local checkout of this repository's **develop** branch. Run from the repository root.
- **This is DEV only.** The script hardcodes AWS `us-east-1` and Lambda `elettro-brand-os-dev-api`. It never targets production.

## Stage A — Inspect the running Lambda (read-only)

Run these from your workstation in the repo root after `git pull` on `develop`:

```bash
aws sts get-caller-identity
aws lambda get-function-configuration --region us-east-1 --function-name elettro-brand-os-dev-api --query '{Name:FunctionName,Runtime:Runtime,Handler:Handler,Status:LastUpdateStatus,RevisionId:RevisionId}' --output json
python scripts/patch-live-dev-lambda-source-id.py
```

Review the output: it should show exactly one line added to **LIVE/db-main.mjs**:

```diff
+            a."sourceFileId",
```

The script saves a uniquely named **LIVE-BACKUP ZIP** and **SOURCE-ID-PATCH ZIP** in `./elettro-dev-lambda-patch/` (ignored by Git). Treat these as private operational archives and keep them for recovery.

If the script stops, do not bypass it. This may mean the live Lambda has a different handler, already has the source ID query, or has changed under another operator. Send only the error text for analysis, not credentials, live ZIP contents or presigned URLs.

## Stage B — Explicit owner-approved DEV deployment

Run **only after** reviewing the Stage A diff and confirming the account/function:

```bash
python scripts/patch-live-dev-lambda-source-id.py --apply --confirm APPLY_DEV_SOURCE_ID_FIX
```

The script re-downloads and rechecks the currently deployed package before applying anything; it requires the exact confirmation and uses the Lambda `RevisionId` to block concurrent overwrites.

It then waits for the update and verifies AWS's current `CodeSha256` matches the patched ZIP.

**This updates Lambda code and may affect the working DEV API; keep the backup until live regression checks finish.** It does not write to the database or Dropbox.

## Stage C — Live acceptance

1. Reopen `https://develop.d2k28tehm1a8zw.amplifyapp.com/ai-gateway`.
2. Keep Stashbox selected, search `SE53F9~1.MP4`.
3. Scroll to Step 5, select the video, and click **Verify existing registration (read-only)**.
4. PASS requires `registrationVerified:true`, `verificationStatus:"registered_in_dropbox"` or `"registered_file_moved"`, and a Dropbox ID matching `id:UM9GhyUcVDgAAAAAAAMB-g`.
5. Confirm that the user dashboard can still search, browse brand folders and (later in a separate approved test) upload/ingest. **Do not perform a test upload or re-registration automatically.**

If Step 5 still returns `source_locator_unavailable`, the database may have a NULL source ID; the patch can expose a stored field but cannot invent a true DB-to-Dropbox identity link. Investigate it read-only first. Do **not** backfill from a mere filename match.

## Rollback (only if required)

The patcher prints the exact path of the live backup ZIP. To restore the previous Lambda code (requires AWS IAM permissions):

```bash
aws lambda update-function-code --region us-east-1 --function-name elettro-brand-os-dev-api --zip-file fileb://PATH_TO_LIVE_BACKUP_ZIP --publish
aws lambda wait function-updated --region us-east-1 --function-name elettro-brand-os-dev-api
```

Use the actual backup path printed by the patcher. Verify the original asset API, Dropbox browsing and upload/registration before calling recovery complete.

## Change isolation

- No changes to production Lambda, shared-stock galleries or Dropbox files.
- No data backfill or guessed ID matching.
- No replacement with potentially stale checked-in Lambda ZIP.
- Browser-only Step 5 verification stays read-only.
- No ChatGPT/Claude credential provisioning or MCP OAuth is part of this patch.

## Developer notes

- `services/dev-api-lambda/db-main.mjs`: next checked-in Lambda source includes `sourceFileId` in the asset detail query.
- `apps/web/lib/ai-gateway.ts`: Step 5 uses stable ID for renamed or moved files within a brand.
- `tests/test_lambda_patch.py`: tests refusal paths, exactly-one-line patch, and ZIP entry equivalence.
- `.github/workflows/ci.yml`: tests patcher offline, with no AWS credentials.

