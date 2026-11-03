#!/usr/bin/env bash
# Scroll relay: AWS setup for services/scroll-relay-lambda (the phone-remote switchboard behind elettro.com/scroll).
# Uses the root profile `elettro` (creates an IAM role, a table and an API): ask Dean first. Safe to re-run.
# Creates: DynamoDB table, IAM role, Lambda, API Gateway WebSocket API (+ stage). Prints the wss:// address at the end.
# Everything is named elettro-scroll-dev*; nothing touches the Publishing Engine, Postgres or any secret.
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-elettro} AWS_REGION=us-east-1 AWS_PAGER=""
ACCOUNT=656260749296
TABLE=elettro-scroll-dev
ROLE=elettro-scroll-dev-relay-role
FN=elettro-scroll-dev-relay
API_NAME=elettro-scroll-dev-ws
STAGE=dev
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$HERE/services/scroll-relay-lambda"

echo "1/6 DynamoDB table $TABLE (pay per request, items expire by themselves via ttl)"
if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE"
fi
aws dynamodb update-time-to-live --table-name "$TABLE" --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null 2>&1 || true

echo "2/6 IAM role $ROLE (this table, and posting to this API's connections, nothing else)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --description "Elettro scroll relay" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name "$ROLE" --policy-name scroll-relay --policy-document '{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:GetItem","dynamodb:Query","dynamodb:DeleteItem"],"Resource":"arn:aws:dynamodb:us-east-1:'"$ACCOUNT"':table/'"$TABLE"'"},
    {"Effect":"Allow","Action":"execute-api:ManageConnections","Resource":"arn:aws:execute-api:us-east-1:'"$ACCOUNT"':*/'"$STAGE"'/POST/@connections/*"}]}'
sleep 10   # a new role needs a moment before Lambda can use it

echo "3/6 Lambda $FN (128 MB / 10 s: it only forwards small messages)"
ZIPDIR=$(mktemp -d -p "$HOME")
PY=$(command -v python || command -v python3)
"$PY" "$HERE/scripts/scroll-relay-zip.py" "$SVC" "$ZIPDIR/relay.zip"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$(cygpath -m "$ZIPDIR")/relay.zip" --query LastModified --output text
else
  aws lambda create-function --function-name "$FN" --runtime nodejs24.x --handler index.handler --memory-size 128 --timeout 10 \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --environment "Variables={RELAY_TABLE=$TABLE}" \
    --zip-file "fileb://$(cygpath -m "$ZIPDIR")/relay.zip" --query FunctionArn --output text
fi
aws lambda wait function-active --function-name "$FN"
rm -rf "$ZIPDIR"
FN_ARN="arn:aws:lambda:us-east-1:$ACCOUNT:function:$FN"

echo "4/6 WebSocket API $API_NAME"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type WEBSOCKET \
    --route-selection-expression '$request.body.action' --query ApiId --output text)
fi
INTEG=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --query 'Items[0].IntegrationId' --output text)
if [ "$INTEG" = "None" ] || [ -z "$INTEG" ]; then
  INTEG=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/$FN_ARN/invocations" --query IntegrationId --output text)
fi

echo "5/6 routes (\$connect, \$disconnect, \$default all go to the one Lambda) and permission"
for R in '$connect' '$disconnect' '$default'; do
  if [ "$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='$R'] | length(@)" --output text)" = "0" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$R" --target "integrations/$INTEG" >/dev/null
  fi
done
aws lambda add-permission --function-name "$FN" --statement-id apigw-scroll-relay --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:$ACCOUNT:$API_ID/*" >/dev/null 2>&1 \
  || echo "  invoke permission already present"

echo "6/6 stage $STAGE (auto-deploy, throttled: 50 requests/s steady, 100 burst)"
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE" >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name "$STAGE" --auto-deploy \
    --default-route-settings ThrottlingRateLimit=50,ThrottlingBurstLimit=100 >/dev/null
fi

echo
echo "Done. Relay address (put this in elettro.com/scroll as RELAY_URL):"
echo "  wss://$API_ID.execute-api.us-east-1.amazonaws.com/$STAGE"
