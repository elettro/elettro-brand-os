# Elettro OS Bug & Fix Knowledge Base

The permanent record of Elettro OS bugs, fixes, regressions and reusable repair procedures. Modeled on the Stashbox Radio
bug system (`SR-BUG-####`); here the IDs are `EOS-BUG-####`. One tracker covers all of Elettro OS; AR is an **Area**, not a
separate tracker (decided 2026-10-29).

## Purpose

Every material defect should leave repair knowledge behind, so a solved problem is never rediscovered and a fix is not
accidentally undone.

## Required workflow

Read `AGENT_WORKFLOW.md` before touching code for a bug. In short: search here first, create or update the `EOS-BUG-####`
record, fix the root cause, then record cause, files, commit, verification and the future repair procedure.

## Structure

- `BUG_INDEX.md` — human-readable master index.
- `BUG_TEMPLATE.md` — copy this for a new bug.
- `AGENT_WORKFLOW.md` — mandatory workflow for AI and developer repair sessions.
- `open/` — active bugs and investigations. `fixed/` — fixed or verified records.
- `repairs/` — reusable repair playbooks by system area.
- `bugs.json` — machine-readable registry (a dashboard page can read it later; the Markdown records stay the source of truth).

## Status

- `Open` reported, not yet diagnosed. `Investigating` diagnosis in progress.
- `Fixed` repair applied (merged and, where needed, deployed) but not yet confirmed.
- `Verified` repaired behavior confirmed by a user, a test or a production check. Record the date and how.
- `Reopened` the issue returned or verification failed.

## Severity

- `Critical` outage, data loss, security exposure, publishing failure with major impact.
- `High` a major function is broken or unusable. `Medium` meaningful defect with a workaround or limited scope.
- `Low` cosmetic or edge case.

## Areas

AR | Publishing | Connections | Review/Planner | Assets/DAM | Auth/Access | Dashboard | API/Infra | Other

## Rule

A bug is not complete until its repair knowledge is retained here. Something never checked is recorded as unchecked, not
as fixed.
