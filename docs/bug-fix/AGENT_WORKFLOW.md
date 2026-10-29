# Elettro OS Repair Workflow

Mandatory for bug work, by Claude, Codex or a developer.

## Before code changes

1. Search `docs/bug-fix/` and `bugs.json` for the same symptom, component, filename or error text.
2. Read the matching playbook under `repairs/`, and the admin runbooks in `docs/admin/` if the bug touches deploys, routes,
   brands or AWS.
3. Inspect the current code and AWS state before reusing an old fix; do not assume the old fix is still in place.
4. If the issue is new, take the next `EOS-BUG-####` number and create a record from `BUG_TEMPLATE.md`.
5. Record failing examples and working comparisons.

## During diagnosis

1. Repair the root cause, not one named example.
2. Check whether the files you change appear in earlier records, and preserve earlier repairs unless evidence says otherwise.
3. Write down each hypothesis you ruled out. A wrong guess that cost time is worth a line.

## After a fix

1. Status `Fixed`; record root cause, files, PR/commit/deploy id, regression risks, related bugs.
2. Write the future repair procedure.
3. Update `bugs.json` and `BUG_INDEX.md`.
4. Promote anything reusable into a `repairs/` playbook, and into `docs/admin/` if it is an admin procedure.

## Verification

Stay at `Fixed` until a user, an automated test or a production check confirms it, then `Verified` with the date and method.
"It should work" is not verification.

## If a problem returns

Reopen the record when the root cause is the same. Open a new related record when a different cause gives the same symptom.
Compare current code with the earlier fixing PR before repairing again.

## Reporting

Say plainly what was verified and what was not. A step skipped or a check that could not be run goes in the record.
