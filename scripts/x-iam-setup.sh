#!/usr/bin/env bash
# X: the two IAM inline policies the connect flow needs (see docs/admin/x-connect.md, part 3).
# Needs the root profile `elettro` (IAM writes), so ask Dean first. Safe to re-run: put-role-policy overwrites the same policy name.
# Grants only the X secret names, nothing broader.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-elettro}" AWS_REGION=us-east-1 AWS_PAGER=""
ACCOUNT=656260749296
SECRETS="arn:aws:secretsmanager:us-east-1:$ACCOUNT:secret:elettro-brand-os-dev"
WEB_ROLE=elettro-brand-os-dev-amplify-compute
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg

# The web role also WRITES x/*: X access tokens last about 2 hours, so the test post refreshes them and saves the rotated pair.
echo "1/2 web role $WEB_ROLE: read the X app secret, read and refresh the X account tokens"
aws iam put-role-policy --role-name "$WEB_ROLE" --policy-name x-connect-oauth --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\", \"Resource\": [\"$SECRETS/x-oauth-*\", \"$SECRETS/x/*\"] },
    { \"Effect\": \"Allow\", \"Action\": \"secretsmanager:PutSecretValue\", \"Resource\": \"$SECRETS/x/*\" }
  ]
}"

echo "2/2 dev-api role $API_ROLE: write X account tokens at connect time"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name x-connect-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\"],
    \"Resource\": \"$SECRETS/x/*\" }]
}"
echo "Done."
