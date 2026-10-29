# Add or fix an HTTP route on the dev-api

HTTP API `zkjngy7rdd` (us-east-1, account 656260749296) in front of Lambda `elettro-brand-os-dev-api`. Verified 2026-10-29
(EOS-BUG-0001): **a route needs two things in AWS besides the code.**

1. **A gateway route** with target `integrations/h25cb92` (the shared Lambda proxy integration). Missing = HTTP 404 from the gateway.
   ```
   aws apigatewayv2 create-route --api-id zkjngy7rdd --route-key "POST /connections/<name>" --target integrations/h25cb92 --region us-east-1 --profile stashbox-audit
   ```
   (`stashbox-audit` could create the route.) Stage `$default` auto-deploys.
2. **A Lambda resource-policy statement per route.** Missing = HTTP 500 "Internal Server Error", while a direct
   `aws lambda invoke` of the same event still works. This was run by Dean with the `elettro` (root) profile; it was not tried
   with `stashbox-audit`.
   ```
   aws lambda add-permission --function-name elettro-brand-os-dev-api --statement-id <name>-route --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:656260749296:zkjngy7rdd/*/*/connections/<name>" --region us-east-1 --profile elettro
   ```

## Smoke test

```
curl -s -w " HTTP %{http_code}\n" -X POST -H "content-type: application/json" -d '{}' https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/<path>
```

Healthy = `401 {"ok":false,"error":"Connect key required"}` (the Lambda's own answer; every route except the two public
status feeds needs `x-elettro-connect-key`). 404 = no route; 500 = no permission.

## Gotchas

- Existing statements show the pattern: `aws lambda get-policy --function-name elettro-brand-os-dev-api` and read each SourceArn.
- In Git Bash, prefix commands that take a `/aws/...` log group with `MSYS_NO_PATHCONV=1` or the path is rewritten.
- A rejected gateway call never reaches the Lambda, so its log has no line for it. Log lines during a 500 may be direct invokes.
- Record the route in the PR's "AWS changes after merge" list; routes are not in git.
