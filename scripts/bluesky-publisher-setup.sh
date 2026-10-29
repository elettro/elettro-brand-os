#!/usr/bin/env bash
# Bluesky publisher: AWS setup for Elettro OS (services/bluesky-lambda).
# Run AFTER the PR is merged and the "Build Bluesky Lambda" run on develop is green, and after
# scripts/bluesky-oauth-setup.mjs has created the signing-key secret.
# Uses the root profile `elettro` (creates an IAM role): ask Dean first. Safe to re-run.
set -euo pipefail
export AWS_PROFILE=elettro AWS_REGION=us-east-1 AWS_PAGER=""
REPO=elettro/elettro-brand-os
ACCOUNT=656260749296
FN=elettro-brand-os-dev-bluesky
ROLE=elettro-brand-os-dev-bluesky-role
RULE=elettro-brand-os-dev-bluesky-tick
API_FN=elettro-brand-os-dev-api

latest_zip() { # workflow -> prints the zip path inside a fresh temp dir under $HOME
  local run dir
  run=$(gh run list -R "$REPO" --workflow "$1" --branch develop --status success --limit 1 --json databaseId -q '.[0].databaseId')
  echo "  $1 build run $run" >&2
  dir=$(mktemp -d -p "$HOME")
  gh run download "$run" -R "$REPO" -D "$dir"
  find "$dir" -name '*.zip' | head -1
}

echo "1/4 IAM role for the Bluesky worker (reads and ROTATES the per-account sessions, so it may write them)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "Elettro OS Bluesky publisher" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE" --policy-name bluesky-worker --policy-document '{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":["secretsmanager:GetSecretValue","secretsmanager:PutSecretValue"],"Resource":"arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/bluesky/*"},
    {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":[
      "arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/bluesky-oauth-*",
      "arn:aws:secretsmanager:us-east-1:'"$ACCOUNT"':secret:elettro-brand-os-dev/dropbox-*"]},
    {"Effect":"Allow","Action":"secretsmanager:ListSecrets","Resource":"*"},
    {"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:us-east-1:'"$ACCOUNT"':function:'"$API_FN"'"}]}'
sleep 10   # a new role needs a moment before Lambda can use it

echo "2/4 Lambda $FN (1024 MB: sharp re-encodes photos and a video can be up to 100 MB; 5 minutes for video processing)"
ZIP=$(latest_zip build-bluesky-lambda.yml)
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$(cygpath -m "$ZIP")" --query LastModified --output text
else
  aws lambda create-function --function-name "$FN" --runtime nodejs24.x --handler index.handler --memory-size 1024 --timeout 300 \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file "fileb://$(cygpath -m "$ZIP")" --query FunctionArn --output text
fi
aws lambda wait function-active --function-name "$FN"
rm -rf "$(dirname "$ZIP")"

echo "3/4 EventBridge: every 15 minutes (a tick with no approved Bluesky post only keeps logins alive)"
aws events put-rule --name "$RULE" --schedule-expression "rate(15 minutes)" --state ENABLED --description "Elettro OS Bluesky scheduled publisher" >/dev/null
aws lambda add-permission --function-name "$FN" --statement-id eventbridge-bluesky-tick --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "arn:aws:events:us-east-1:$ACCOUNT:rule/$RULE" >/dev/null 2>&1 \
  || echo "  invoke permission already present"
aws events put-targets --rule "$RULE" --targets "Id=bluesky,Arn=arn:aws:lambda:us-east-1:$ACCOUNT:function:$FN" >/dev/null

echo "4/4 done. Check: aws lambda invoke --function-name $FN --payload '{\"action\":\"refresh\"}' out.json"
