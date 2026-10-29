# Deploy merged dev-api code to AWS

Deploys are manual. Merging to `develop` redeploys the **web app** (Amplify) by itself but does **not** touch the Lambda.
Verified 2026-10-29 (deployed PRs #240, #242, #243).

1. Find the build for the merged commit: workflow **"Build DEV API Lambda"** on `develop`:
   `gh run list --workflow "Build DEV API Lambda" -L 3 --json databaseId,headSha,conclusion`. Pick the newest run whose
   `headSha` is the merge commit and whose conclusion is `success`.
2. Download the artifact into a new empty folder: `gh run download <runId> -R elettro/elettro-brand-os -D art`
   (file: `art/elettro-brand-os-dev-api/elettro-brand-os-dev-api.zip`).
3. Check the zip has the change. Files sit at the zip root, not under `services/`, e.g. `unzip -p <zip> db-main.mjs | grep <slug>`.
4. Upload (the `stashbox-audit` profile can do this):
   ```
   aws lambda update-function-code --function-name elettro-brand-os-dev-api --zip-file fileb://<zip> --profile stashbox-audit --region us-east-1
   ```
   In Git Bash on Windows, pass the path through `cygpath -w` if `fileb://` cannot find it.
5. Wait for `LastUpdateStatus` = `Successful` (about 20 s):
   `aws lambda get-function-configuration --function-name elettro-brand-os-dev-api --query "[LastUpdateStatus,CodeSha256]"`.
6. Smoke test: `curl https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/status/connections` returns `"ok":true`.

Other Lambdas have their own "Build ..." workflows and artifacts; the worker Lambdas may need the root profile (see `CLAUDE.md` section 3).
`CLAUDE.md` also says the dev-api is built locally with `npm run build`; the CI artifact above worked and is simpler.
