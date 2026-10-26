#!/usr/bin/env bash
# Google Business Profile publisher: AWS setup for Elettro OS (services/gmb-lambda).
# Run AFTER the PR is merged and both "Build DEV API Lambda" and "Build GBP Lambda" runs on develop are green.
# Uses the root profile `elettro` (creates an IAM role). Safe to re-run.
set -euo pipefail
export AWS_PROFILE=elettro AWS_REGION=us-east-1 AWS_PAGER=""
REPO=elettro/elettro-brand-os
ACCOUNT=656260749296
FN=elettro-brand-os-dev-gmb
ROLE=elettro-brand-os-dev-gmb-role
RULE=elettro-brand-os-dev-gmb-tick
API_FN=elettro-brand-os-dev-api

latest_zip() { # workflow -> prints the zip path inside a fresh temp dir under $HOME
  local run dir
  run=$(gh run list -R "$REPO" --workflow "$1" --branch develop --status success --limit 1 --json databaseId -q '.[0].databaseId')
  echo "  $1 build run $run" >&2
  dir=$(mktemp -d -p "$HOME")
  gh run download "$run" -R "$REPO" -D "$dir"
  find "$dir" -name '*.zip' | head -1
}

echo "1/5 dev-api: deploy the build that hands out GBP fields and the 30-day mix"
ZIP=$(latest_zip build-dev-api-lambda.yml)
aws lambda update-function-code --function-name "$API_FN" --zip-file "fileb://$(cygpath -m "$ZIP")" --query LastModified --output text
aws lambda wait function-updated --function-name "$API_FN"
rm -rf "$(dirname "$ZIP")"

echo "2/5 IAM role for the GBP worker"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "Elettro OS GBP publisher" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE" --policy-name gmb-worker --policy-document '{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":[
      "arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/gmb/*",
      "arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/google-oauth-*",
      "arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/dropbox-*"]},
    {"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:us-east-1:'"$ACCOUNT"':function:'"$API_FN"'"}]}'
sleep 10   # a new role needs a moment before Lambda can use it

echo "3/5 Lambda $FN"
ZIP=$(latest_zip build-gmb-lambda.yml)
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$(cygpath -m "$ZIP")" --query LastModified --output text
else
  aws lambda create-function --function-name "$FN" --runtime nodejs24.x --handler index.handler --memory-size 256 --timeout 120 \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file "fileb://$(cygpath -m "$ZIP")" --query FunctionArn --output text
fi
aws lambda wait function-active --function-name "$FN"
rm -rf "$(dirname "$ZIP")"

echo "4/5 EventBridge: every 15 minutes (a tick with no approved GBP post does nothing)"
aws events put-rule --name "$RULE" --schedule-expression "rate(15 minutes)" --state ENABLED --description "Elettro OS GBP scheduled publisher" >/dev/null
aws lambda add-permission --function-name "$FN" --statement-id eventbridge-gmb-tick --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "arn:aws:events:us-east-1:$ACCOUNT:rule/$RULE" >/dev/null 2>&1 \
  || echo "  invoke permission already present"
aws events put-targets --rule "$RULE" --targets "Id=gmb,Arn=arn:aws:lambda:us-east-1:$ACCOUNT:function:$FN" >/dev/null

echo "5/5 Check: one tick by hand (expect ok:true, published:[])"
OUT=$(mktemp -p "$HOME")
aws lambda invoke --function-name "$FN" --payload '{"action":"tick"}' --cli-binary-format raw-in-base64-out "$(cygpath -m "$OUT")" --query StatusCode --output text
head -c 300 "$OUT"; echo; rm -f "$OUT"
echo "Done. Nothing posts until a GBP post is queued and approved."
