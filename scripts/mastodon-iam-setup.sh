#!/usr/bin/env bash
# Mastodon: the two IAM inline policies the connect flow needs (see docs/admin/mastodon-connect.md step 4).
# Needs the root profile `elettro` (IAM writes). Safe to re-run: put-role-policy overwrites the same policy name.
# Grants only the Mastodon secret names, nothing broader.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-elettro}" AWS_REGION=us-east-1 AWS_PAGER=""
ACCOUNT=656260749296
SECRETS="arn:aws:secretsmanager:us-east-1:$ACCOUNT:secret:elettro-brand-os-dev"
WEB_ROLE=elettro-brand-os-dev-amplify-compute
API_ROLE=elettro-brand-os-dev-api-role-ddsp99yg

echo "1/2 web role $WEB_ROLE: read the Mastodon app secret and account tokens"
aws iam put-role-policy --role-name "$WEB_ROLE" --policy-name mastodon-connect-oauth --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\",
    \"Resource\": [\"$SECRETS/mastodon-oauth-*\", \"$SECRETS/mastodon/*\"] }]
}"

echo "2/2 dev-api role $API_ROLE: write Mastodon account tokens"
aws iam put-role-policy --role-name "$API_ROLE" --policy-name mastodon-connect-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": [\"secretsmanager:CreateSecret\", \"secretsmanager:PutSecretValue\"],
    \"Resource\": \"$SECRETS/mastodon/*\" }]
}"
echo "Done."
