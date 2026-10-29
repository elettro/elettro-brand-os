#!/usr/bin/env bash
# Bluesky connect: AWS setup for Elettro OS (step 1, PR #248). Run AFTER #248 is merged and the
# "Build DEV API Lambda" run on develop is green. Uses the root profile `elettro` (IAM + secret writes). Safe to re-run.
#
#   1  signing key secret  elettro-brand-os-dev/bluesky-oauth          (node scripts/bluesky-oauth-setup.mjs)
#   2  web role            elettro-brand-os-dev-amplify-compute         read the signing key
#   3  dev-api role        elettro-brand-os-dev-api-role-ddsp99yg       create/write elettro-brand-os-dev/bluesky/*
#   4  API Gateway         POST /connections/bluesky/complete           same integration as /connections/threads/complete
#   5  dev-api Lambda      deploy the latest develop build
set -euo pipefail
export AWS_PROFILE=elettro AWS_REGION=us-east-1 AWS_PAGER=""
REPO=elettro/elettro-brand-os
ACCOUNT=656260749296
API_ID=zkjngy7rdd
API_FN=elettro-brand-os-dev-api
WEB_ROLE=elettro-brand-os-dev-amplify-compute
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg
cd "$(dirname "$0")/.."

echo "1/5 signing key (refuses to overwrite an existing one)"
if aws secretsmanager describe-secret --secret-id elettro-brand-os-dev/bluesky-oauth >/dev/null 2>&1; then
  echo "  already exists, leaving it alone"
else
  (cd apps/web && node ../../scripts/bluesky-oauth-setup.mjs --profile elettro)
fi

echo "2/5 web role may read the signing key"
aws iam put-role-policy --role-name "$WEB_ROLE" --policy-name bluesky-connect-oauth --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/bluesky-oauth-*"}]}'

echo "3/5 dev-api role may store Bluesky sessions"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name bluesky-connect-secrets --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":["secretsmanager:CreateSecret","secretsmanager:PutSecretValue"],"Resource":"arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/bluesky/*"}]}'

echo "4/5 API Gateway route"
TARGET=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /connections/threads/complete'].Target | [0]" --output text)
if [ -z "$TARGET" ] || [ "$TARGET" = "None" ]; then echo "  cannot find the Threads route to copy its integration"; exit 1; fi
if aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /connections/bluesky/complete'].RouteId" --output text | grep -q .; then
  echo "  route already exists"
else
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "POST /connections/bluesky/complete" --target "$TARGET" --query RouteId --output text
fi
aws lambda add-permission --function-name "$API_FN" --statement-id apigw-bluesky-complete --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:$ACCOUNT:$API_ID/*/POST/connections/bluesky/complete" >/dev/null 2>&1 \
  || echo "  invoke permission already present"

echo "5/5 deploy the dev-api Lambda from the latest green develop build"
RUN=$(gh run list -R "$REPO" --workflow build-dev-api-lambda.yml --branch develop --status success --limit 1 --json databaseId -q '.[0].databaseId')
echo "  build run $RUN"
DIR=$(mktemp -d -p "$HOME")
gh run download "$RUN" -R "$REPO" -D "$DIR"
ZIP=$(find "$DIR" -name '*.zip' | head -1)
aws lambda update-function-code --function-name "$API_FN" --zip-file "fileb://$(cygpath -m "$ZIP")" --query LastModified --output text
aws lambda wait function-updated --function-name "$API_FN"
rm -rf "$DIR"

echo "Done. Check: curl -s https://os.elettro.com/api/connections/bluesky/client-metadata   (must return JSON)"
