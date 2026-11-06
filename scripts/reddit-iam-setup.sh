#!/usr/bin/env bash
# Reddit: the two IAM inline policies the connect flow needs (docs/admin/reddit-connect.md, part 2).
# Needs the root profile `elettro` (IAM writes), so ask Dean first. Safe to re-run. Grants only the Reddit secret names.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-elettro}" AWS_REGION=us-east-1 AWS_PAGER=""
ACCOUNT=656260749296
SECRETS="arn:aws:secretsmanager:us-east-1:$ACCOUNT:secret:elettro-brand-os-dev"
WEB_ROLE=elettro-brand-os-dev-amplify-compute
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg

# The web role also WRITES reddit/*: access tokens last 1 hour, so the test post refreshes and saves the new one.
echo "1/2 web role $WEB_ROLE"
aws iam put-role-policy --role-name "$WEB_ROLE" --policy-name reddit-connect-oauth --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\", \"Resource\": [\"$SECRETS/reddit-oauth-*\", \"$SECRETS/reddit/*\"] },
    { \"Effect\": \"Allow\", \"Action\": \"secretsmanager:PutSecretValue\", \"Resource\": \"$SECRETS/reddit/*\" }
  ]
}"
echo "2/2 dev-api role $API_ROLE"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name reddit-connect-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\"],
    \"Resource\": \"$SECRETS/reddit/*\" }]
}"
echo "Done."
