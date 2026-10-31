# Elettro OS Admin Knowledge Base

Task-by-task runbooks for administering Elettro OS: the things a new admin or a fresh Claude session would otherwise guess.
`CLAUDE.md` (repo root) is the map (architecture, AWS names, credentials); these are the procedures.

## Runbooks

- [add-a-brand.md](add-a-brand.md): add a brand end to end (code lists, database row, Dropbox, per-network lists).
- [new-api-route.md](new-api-route.md): add or fix an HTTP route on the dev-api (gateway route + Lambda permission).
- [deploy-dev-api-lambda.md](deploy-dev-api-lambda.md): get merged dev-api code running in AWS.
- [x-connect.md](x-connect.md): connect X accounts (create the X app, store its credentials, IAM, first test post).

## Rules for every runbook

1. **Only write what was done or checked.** Each step says whether it was run ("verified 2026-10-29") or is an assumption.
2. **Unknowns go in an "Unknown / ask Dean" list**, never filled with a guess.
3. **Update the runbook in the same PR** as any change that makes it wrong, and whenever a session had to figure a step out the
   hard way. The next session should not repeat the discovery.
4. A bug that exposes a missing procedure gets an `EOS-BUG` record (`docs/bug-fix/`) and a runbook fix.
5. No secrets, tokens or key values, ever. Secret *names* are fine.

## Planned

A page in the OS that renders these runbooks for admins; a checklist template for new network connections.
