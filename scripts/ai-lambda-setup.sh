#!/usr/bin/env bash
# AI Lambda: AWS setup for Elettro OS (services/ai-lambda). Runbook: docs/admin/ai-lambda.md.
# Run AFTER the PR is merged and the "Build AI Lambda" run on develop is green.
# Uses the root profile `elettro` (creates an IAM role, edits the dev-api role): ask Dean first. Safe to re-run.
#
#   scripts/ai-lambda-setup.sh            steps 1-4: role, Lambda, dev-api wiring, smoke test. AI stays OFF.
#   scripts/ai-lambda-setup.sh --enable   also step 5: sets EPE_BEDROCK_CURATOR_MODEL_ID on the dev-api, which turns
#                                         on AI picks + AI captions for every Plan, planner tick and Calendar swap.
set -euo pipefail
export AWS_PROFILE=elettro AWS_REGION=us-east-1 AWS_PAGER=""
REPO=elettro/elettro-brand-os
ACCOUNT=656260749296
FN=elettro-brand-os-dev-ai
ROLE=elettro-brand-os-dev-ai-role
API_FN=elettro-brand-os-dev-api
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg
# Haiku 5.5 is the target, but on 2026-11-07 Bedrock refused it for this account ("not available for this account",
# agreement already exists), while Haiku 4.5 works. Until AWS enables 5.5, MODEL is 4.5; switch it back when it is.
MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
BASE=anthropic.claude-haiku-5-5
FALLBACK=anthropic.claude-haiku-4-5-20251001-v1:0
ALLOWED=us.anthropic.claude-haiku-5-5,global.anthropic.claude-haiku-5-5,us.$FALLBACK

latest_zip() { # workflow -> prints the zip path inside a fresh temp dir under $HOME
  local run dir
  run=$(gh run list -R "$REPO" --workflow "$1" --branch develop --status success --limit 1 --json databaseId -q '.[0].databaseId')
  echo "  $1 build run $run" >&2
  dir=$(mktemp -d -p "$HOME")
  gh run download "$run" -R "$REPO" -D "$dir"
  find "$dir" -name '*.zip' | head -1
}

# Merge variables into a Lambda's environment. update-function-configuration REPLACES the whole map,
# so read the current one first. Values are never printed.
set_env() { # function KEY=VALUE...
  local fn=$1; shift
  local current
  current=$(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables' --output json)
  node -e '
    const cur = JSON.parse(process.argv[1] === "null" ? "{}" : process.argv[1]);
    for (const kv of process.argv.slice(2)) { const i = kv.indexOf("="); cur[kv.slice(0, i)] = kv.slice(i + 1); }
    require("fs").writeFileSync(process.env.HOME + "/ai-env.json", JSON.stringify({ Variables: cur }));
  ' "$current" "$@"
  aws lambda update-function-configuration --function-name "$fn" --environment "file://$(cygpath -m "$HOME/ai-env.json" 2>/dev/null || echo "$HOME/ai-env.json")" --query LastUpdateStatus --output text
  rm -f "$HOME/ai-env.json"
  aws lambda wait function-updated --function-name "$fn"
}

echo "1/5 IAM role for the AI Lambda (Bedrock Converse on Haiku 5.5 + 4.5 fallback only; logs)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "Elettro OS AI relay (Bedrock)" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
# A cross-region profile routes to the foundation model in other regions, so the model ARN needs every region;
# the global profile uses the region-less ARN. Marketplace actions cover Bedrock's first-use subscription check.
aws iam put-role-policy --role-name "$ROLE" --policy-name ai-bedrock --policy-document '{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":[
      "arn:aws:bedrock:us-east-1:'"$ACCOUNT"':inference-profile/us.'"$BASE"'",
      "arn:aws:bedrock:us-east-1:'"$ACCOUNT"':inference-profile/global.'"$BASE"'",
      "arn:aws:bedrock:*::foundation-model/'"$BASE"'",
      "arn:aws:bedrock:::foundation-model/'"$BASE"'",
      "arn:aws:bedrock:us-east-1:'"$ACCOUNT"':inference-profile/us.'"$FALLBACK"'",
      "arn:aws:bedrock:*::foundation-model/'"$FALLBACK"'"]},
    {"Effect":"Allow","Action":["aws-marketplace:ViewSubscriptions","aws-marketplace:Subscribe"],"Resource":"*"}]}'
sleep 10   # a new role needs a moment before Lambda can use it

echo "2/5 Lambda $FN (256 MB / 60 s, OUTSIDE the VPC so it can reach Bedrock)"
ZIP=$(latest_zip build-ai-lambda.yml)
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$(cygpath -m "$ZIP")" --query LastModified --output text
else
  aws lambda create-function --function-name "$FN" --runtime nodejs24.x --handler index.handler --memory-size 256 --timeout 60 \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file "fileb://$(cygpath -m "$ZIP")" --query FunctionArn --output text
fi
aws lambda wait function-active --function-name "$FN"
set_env "$FN" "AI_ALLOWED_MODEL_IDS=$ALLOWED"
rm -rf "$(dirname "$ZIP")"

echo "3/5 dev-api may invoke the AI Lambda (inline policy ElettroBrandOSDevInvokeAi) and knows its name (AI_FUNCTION_NAME)"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name ElettroBrandOSDevInvokeAi --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:us-east-1:'"$ACCOUNT"':function:'"$FN"'"}]}'
set_env "$API_FN" "AI_FUNCTION_NAME=$FN"

echo "4/5 smoke test: one tiny Haiku call through the AI Lambda (costs a fraction of a cent)"
OUT=$(mktemp -p "$HOME")
aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"action":"converse-v1","modelId":"'"$MODEL"'","system":"","user":"Reply with just: OK","maxTokens":10}' "$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")" >/dev/null
cat "$OUT"; echo; rm -f "$OUT"

if [ "${1:-}" = "--enable" ]; then
  echo "5/5 turning AI ON: EPE_BEDROCK_CURATOR_MODEL_ID=$MODEL on the dev-api"
  set_env "$API_FN" "EPE_BEDROCK_CURATOR_MODEL_ID=$MODEL"
else
  echo "5/5 skipped: AI stays off. Re-run with --enable to set EPE_BEDROCK_CURATOR_MODEL_ID (AI picks + captions)."
fi
echo "done."
