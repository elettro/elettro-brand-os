# Repair playbook: API Gateway routes and Lambda permissions

Applies to the dev-api HTTP API (`zkjngy7rdd`, us-east-1, account 656260749296) in front of Lambda `elettro-brand-os-dev-api`.

## Symptoms and meaning

| What the web app shows | What it means |
|---|---|
| HTTP 404 `{"message":"Not Found"}` from the gateway | No route for that method + path. |
| HTTP 500 `{"message":"Internal Server Error"}`, and the same event works with `aws lambda invoke` | Route exists but the Lambda resource policy has no statement for that route. |
| HTTP 401 `Connect key required` | Route and permission are fine; the request had no valid `x-elettro-connect-key`. This is the healthy answer for a keyless smoke test. |

## Procedure

1. List routes: `aws apigatewayv2 get-routes --api-id zkjngy7rdd --query "Items[].RouteKey"`.
2. Missing: create it with target `integrations/h25cb92` (the shared Lambda proxy integration).
3. Check the Lambda policy: `aws lambda get-policy --function-name elettro-brand-os-dev-api`, look for a statement whose SourceArn
   ends in the route path. Missing: `aws lambda add-permission` (Dean runs it; see `docs/admin/new-api-route.md`).
4. Smoke test with curl and no key; expect 401.

Past cases: EOS-BUG-0001.
