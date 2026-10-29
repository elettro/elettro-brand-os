# EOS-BUG-0003 - dev-api build fails: new module missing from the zip file list (Bluesky)

Status: Fixed
Severity: Medium
Area: API/Infra
Environment: DEV
Date reported: 2026-10-29
Date fixed: 2026-10-29
Date verified:
Reported by: Claude (found while deploying PR #249)

## Symptom

The "Build DEV API Lambda" workflow failed on develop (runs 40887723357 on 2227557 and 40888467231 on 298e5da) at "Verify packaged
handler loads": `Cannot find module '/tmp/zipcheck/bluesky-connect.mjs' imported from /tmp/zipcheck/index.mjs`. No zip artifact was produced.

## Reproduction

Merge a PR that adds a module imported by `index.mjs` without adding it to the zip lists in `.github/workflows/build-dev-api-lambda.yml`.

## Affected examples

PR #248 (Bluesky step 1) added `bluesky-connect.mjs`; it is in `services/dev-api-lambda/package.json` build but not in the workflow.

## Working comparison

Earlier builds passed. Same class of bug as #168 (dashboard-stats), #183 (api-gate), #187 (gmb-connect), #223 (connection-disconnect).

## Root cause

The workflow keeps its own hand-written list of files to syntax-check and zip, separate from `package.json`'s build script. A new module
has to be added in both places; nothing enforced it. The workflow's load check caught it before a broken zip could be deployed.

## Fix

Added `bluesky-connect.mjs` to the workflow's check and zip lists, and `tests/dev-api-zip-contents.test.mjs`: follows every relative import
from `index.mjs` and fails if a reachable module is missing from the zip list in the workflow or in package.json. Wired into ci.yml.

## Files changed

- `.github/workflows/build-dev-api-lambda.yml`, `.github/workflows/ci.yml`, `tests/dev-api-zip-contents.test.mjs`

## Commits / PRs

This PR (branch `fix/dev-api-zip-bluesky`).

## Verification

Test fails without the fix ("missing from the zip: bluesky-connect.mjs") and passes with it. NOT verified: the Build DEV API Lambda run on develop after merge.

## Regression risk

Low. The test only reads files; a future module imported dynamically (not via a literal relative path) would not be seen by it.

## Related bugs

None.

## Future repair procedure

Add the new module to BOTH the workflow (`node --check` and the `zip -r` list) and `services/dev-api-lambda/package.json`; run
`node --test tests/dev-api-zip-contents.test.mjs`. Until the zip is fixed, the previous artifact still works for deploys.

## Notes

Found because the LinkedIn company-page PR (#249) needed a dev-api deploy and the artifact for its merge commit did not exist.
