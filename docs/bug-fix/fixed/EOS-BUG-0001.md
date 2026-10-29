# EOS-BUG-0001 - Disconnect button failed with HTTP 404 (then 500) on every network

Status: Fixed
Severity: High
Area: Connections
Environment: DEV
Date reported: 2026-10-29
Date fixed: 2026-10-29
Date verified:
Reported by: Dean

## Symptom

Clicking Disconnect on the Elettro LinkedIn card showed "Disconnect failed (HTTP 404)".

## Reproduction

1. Connections page, click Disconnect on any connected network, confirm.
2. Expected: the account is unlinked. Actual: "Disconnect failed (HTTP 404)".
3. After the route was added (below) the same request returned HTTP 500 until the permission was added.

## Affected examples

LinkedIn / Elettro (reported). The route is shared, so every network's Disconnect button was affected. That it never worked
from the UI since PR #222 is an inference from the missing route; no other network was clicked.

## Working comparison

`POST /connections/linkedin/complete` and the other `/connections/*/complete` routes worked: each has its own gateway route
and its own Lambda invoke permission.

## Root cause

Two missing pieces of AWS wiring, not code. The Lambda handler (`connection-disconnect.mjs`) and web route shipped in PRs #222
and #223 and were deployed.

1. The API Gateway (HTTP API `zkjngy7rdd`) had no `POST /connections/disconnect` route, so the gateway answered 404 itself.
2. After the route existed, the dev-api Lambda's resource policy had no statement allowing API Gateway to invoke it for that
   route. The Lambda policy here is per route, so the gateway answered 500 "Internal Server Error".

## Fix

1. Created route `POST /connections/disconnect` (route id `aqvtww7`) targeting integration `h25cb92`, the integration the other
   connect routes use (done with the `stashbox-audit` profile).
2. Dean ran `aws lambda add-permission` with the `elettro` profile: statement id `disconnect-route`, principal
   `apigateway.amazonaws.com`, source ARN `arn:aws:execute-api:us-east-1:656260749296:zkjngy7rdd/*/*/connections/disconnect`.

## Files changed

None: infrastructure only (API Gateway route + Lambda resource policy).

## Commits / PRs

Code from PR #222 and #223 (unchanged). AWS changes made 2026-10-29, not in git.

## Verification

After the permission: `POST https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/connections/disconnect` with no key returned
HTTP 401 `{"ok":false,"error":"Connect key required"}`, which is the Lambda's own answer. NOT verified: a real Disconnect click
through the web app. It was not clicked, to avoid unlinking a live account without Dean. Stays `Fixed` until Dean confirms.

## Regression risk

Low. A redeploy of the Lambda zip does not touch the route or the permission. Recreating the API Gateway would lose both.

## Related bugs

- EOS-BUG-0002

## Future repair procedure

See `repairs/api-gateway-routes.md` and `docs/admin/new-api-route.md`. Short form: a gateway 404 means the route is missing;
a gateway 500 with the Lambda working when invoked directly means the Lambda resource policy lacks the route.

## Notes

Misleading signals worth remembering:
- Invoking the Lambda directly (`aws lambda invoke`) returned the correct 401 while the gateway returned 500. A direct invoke
  does not prove the gateway is allowed to call it.
- CloudWatch showed Lambda invocations during the 500 period; those came from direct invokes, not from the gateway. The
  gateway's rejected calls never reach the Lambda, so they leave no log line.
- In Git Bash, log group names starting with `/` are rewritten to Windows paths; prefix the command with `MSYS_NO_PATHCONV=1`.
