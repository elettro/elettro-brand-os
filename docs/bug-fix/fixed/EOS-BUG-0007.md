# EOS-BUG-0007 - Amplify web build fails on a type error; nothing deploys (os.elettro.com/bugs is 404)

Status: Fixed
Severity: High
Area: API/Infra
Environment: DEV
Date reported: 2026-11-03
Date fixed: 2026-11-03
Date verified:
Reported by: Dean ("https://os.elettro.com/bugs is 404")

## Symptom

`os.elettro.com/bugs` returned 404 after PR #317 merged. Amplify builds 461-464 (PRs #315, #316, #317, #318) all FAILED, so no web change after #311 was deployed.

## Reproduction

1. `npm install`, then `npx tsc --noEmit` in `apps/web` (or `next build`).
2. Expected: no errors. Actual: `lib/ai-mcp-oauth.ts(133,55): No overload matches this call ... Argument of type '"creative-assets"' is not assignable to parameter ...`.

## Affected examples

Every web change merged to develop after the creative-assets gateway change (#315 and later), including the Bug Tracker page.

## Working comparison

Build 460 (PR #311) succeeded.

## Root cause

`brandConfigs.map(brand => brand.id)` is typed as the union of brand ids; `.concat(SHARED_LIBRARY_ID)` adds a plain string, which that array type rejects. `next build` type-checks, so the build failed.

## Fix

Widen the mapped array to `string[]`: `brandConfigs.map((brand): string => brand.id).concat(SHARED_LIBRARY_ID)` in `apps/web/lib/ai-mcp-oauth.ts`.

## Files changed

- `apps/web/lib/ai-mcp-oauth.ts`

## Commits / PRs

- PR (fix/ai-mcp-oauth-brandslugs-type)

## Verification

`tsc --noEmit` in apps/web is clean after the fix. Amplify build after merge not yet checked.

## Regression risk

None at runtime: a type-only change.

## Related bugs

- none

## Future repair procedure

1. When a page 404s or a change is missing, check `aws amplify list-jobs --app-id d2k28tehm1a8zw --branch-name develop --profile stashbox-audit` before debugging the page.
2. Read the BUILD log (`get-job`, step logUrl) and grep for `Type error`.
3. Run `npx tsc --noEmit` in `apps/web` before opening any web PR. Do not dismiss an existing error as unrelated: it still fails the deploy.

## Notes

Found late because the errors were seen locally in PR #317 and wrongly dismissed as pre-existing and unrelated.
