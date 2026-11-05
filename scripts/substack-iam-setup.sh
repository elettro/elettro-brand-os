#!/usr/bin/env bash
# Substack: the two IAM inline policies the connect flow and test post need (see docs/admin/substack-connect.md).
# Needs the root profile `elettro` (IAM writes): ask Dean first. Safe to re-run: put-role-policy overwrites the same policy name.
# Grants only the Substack secret names (the stored session cookies), nothing broader.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-elettro}" AWS_REGION=us-east-1 AWS_PAGER=""
ACCOUNT=656260749296
SECRETS="arn:aws:secretsmanager:us-east-1:$ACCOUNT:secret:elettro-brand-os-dev"
WEB_ROLE=elettro-brand-os-dev-amplify-compute
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg

echo "1/2 web role $WEB_ROLE: read the stored Substack cookie (the Connections test post uses it)"
aws iam put-role-policy --role-name "$WEB_ROLE" --policy-name substack-connect --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\",
    \"Resource\": \"$SECRETS/substack/*\" }]
}"

echo "2/2 dev-api role $API_ROLE: write the Substack cookie when a brand connects"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name substack-connect-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\"],
    \"Resource\": \"$SECRETS/substack/*\" }]
}"
echo "Done. (ListSecrets on * already exists on the web role from the LinkedIn connect policy.)"
