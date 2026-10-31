# EOS-BUG-0004 - Holidays page keeps showing every brand after picking one in the header dropdown

Status: Fixed
Severity: Medium
Area: Review/Planner
Environment: DEV
Date reported: 2026-10-31
Date fixed: 2026-10-31
Date verified:
Reported by: Dean

## Symptom

On the Halloween page (`/holidays/halloween`) with the header dropdown set to Stashbox, the other brands' Halloween drafts and pictures were still listed. Expected: only Stashbox's.

## Reproduction

1. Open `/holidays/halloween` on All brands (every brand's drafts appear).
2. Choose Stashbox in the header dropdown (URL becomes `?brand=stashbox`).
3. Expected: only Stashbox. Actual: every brand still shown.

## Affected examples

`/holidays/halloween` for the owner account. Not reproduced by a full page load of `?brand=stashbox`, which renders only Stashbox (the server filters correctly).

## Working comparison

A hard reload of `/holidays/halloween?brand=stashbox` shows only Stashbox. All `holiday-*` dev-api queries are scoped by `"brandId"` (`services/dev-api-lambda/holidays.mjs`), so the data was never mixed.

## Root cause

`HolidayClient` copies its `initial` prop into state once (`useState(initial)`). The header dropdown only changes the `?brand=` query, so Next.js re-renders the server page but keeps the same client component instance, and React ignores a changed `initial` prop. The list loaded for All brands stayed in state.

## Fix

Give `HolidayClient` a `key` of the chosen brand (`single || "all"`) in `apps/web/app/holidays/[key]/page.tsx`, so React mounts a fresh client, and fresh state, whenever the brand changes.

## Files changed

- `apps/web/app/holidays/[key]/page.tsx`

## Commits / PRs

- PR (fix/holidays-brand-filter)

## Verification

Not yet verified in the browser. `tsc --noEmit` on apps/web shows no errors in the changed file (one unrelated error in packages/database because the Prisma client was not generated). To verify: open All brands, switch to Stashbox, expect only Stashbox.

## Regression risk

Switching brand now resets unsaved edits in the Holiday page (an open caption edit or Swap picker); approved/skipped state is reloaded from the server. Other client components that copy a prop into state on pages driven by `?brand=` could have the same bug (not checked).

## Related bugs

- none

## Future repair procedure

If a `?brand=` page shows stale data after using the header dropdown but is right after a reload, look for `useState(initial)` in a client component and key it by the brand (or derive state from props).

## Notes

The dropdown is `components/brand-switcher.tsx`; it pushes `?brand=` and does not reload the page.
