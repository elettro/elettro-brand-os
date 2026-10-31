# EOS-BUG-0005 - dev-api build fails again: gmb-planner.mjs missing from the zip list, and the guard test could not see it

Status: Fixed
Severity: Medium
Area: API/Infra
Environment: DEV
Date reported: 2026-10-31
Date fixed: 2026-10-31
Date verified:
Reported by: Claude (found while deploying PR #291)

## Symptom

"Build DEV API Lambda" failed on develop (run 41248382923, merge commit 4fe1a72) at "Verify packaged handler loads":
`Cannot find module '/tmp/zipcheck/gmb-planner.mjs' imported from /tmp/zipcheck/planner-review.mjs`. No zip artifact, so nothing was deployed.

## Reproduction

Add a module to the dev-api and name it in the workflow's `node --check` list but not in its `zip -r` list.

## Affected examples

PR #291 added `gmb-planner.mjs` (imported by `planner-review.mjs`). It went into `package.json` build and the workflow's syntax-check list, but not the workflow's zip list.

## Working comparison

`tests/dev-api-zip-contents.test.mjs` (added for EOS-BUG-0003) passed locally and in CI on the PR.

## Root cause

The workflow keeps the syntax-check list and the `zip -r` list on one long line. The test took every word on that line as "in the zip",
so a module named only in the `node --check` part passed. Sixth occurrence of the missing-from-zip class (#168, #183, #187, #223, EOS-BUG-0003).

## Fix

`gmb-planner.mjs` added to the workflow zip list, and the test now reads only the words after `zip -r elettro-brand-os-dev-api.zip`.
Checked: the stricter test fails on the merged workflow ("missing from the zip: gmb-planner.mjs") and passes with the fix.

## Files changed

- `.github/workflows/build-dev-api-lambda.yml`
- `tests/dev-api-zip-contents.test.mjs`

## Commits / PRs

- PR (fix/dev-api-zip-gmb-planner)

## Verification

Local test only. Verified when the "Build DEV API Lambda" run on develop after this PR succeeds.

## Regression risk

None at runtime. The test is now stricter: a module listed only in the syntax-check part fails it.

## Related bugs

- EOS-BUG-0003

## Future repair procedure

When "Verify packaged handler loads" says `Cannot find module`, add the named file to the `zip -r` list in the workflow and to `package.json` build, and run `node --test tests/dev-api-zip-contents.test.mjs`.

## Notes

Dev-api deploy was held until the build was green; nothing reached AWS from the failed build.
