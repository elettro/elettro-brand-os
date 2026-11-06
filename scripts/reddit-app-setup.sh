#!/usr/bin/env bash
# Reddit: store the Elettro OS app credentials in Secrets Manager (docs/admin/reddit-connect.md, part 1).
# Create the app by hand at https://www.reddit.com/prefs/apps first (type "web app"), then run this.
# Uses the `stashbox-audit` profile. The id and secret are read from the environment or prompted for (hidden).
#   REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... scripts/reddit-app-setup.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-stashbox-audit}" AWS_REGION=us-east-1 AWS_PAGER=""
SECRET=elettro-brand-os-dev/reddit-oauth

if [ -z "${REDDIT_CLIENT_ID:-}" ]; then read -r -p "Reddit client id (under the app name): " REDDIT_CLIENT_ID; fi
if [ -z "${REDDIT_CLIENT_SECRET:-}" ]; then read -r -s -p "Reddit client secret: " REDDIT_CLIENT_SECRET; echo; fi
if [ -z "$REDDIT_CLIENT_ID" ] || [ -z "$REDDIT_CLIENT_SECRET" ]; then echo "Both the client id and the secret are required" >&2; exit 1; fi

BODY=$(node -e 'process.stdout.write(JSON.stringify({ clientId: process.env.REDDIT_CLIENT_ID, clientSecret: process.env.REDDIT_CLIENT_SECRET }))')
echo "storing the credentials as $SECRET"
if aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "$BODY" --query Name --output text
else
  aws secretsmanager create-secret --name "$SECRET" --description "Elettro OS Reddit app (OAuth web app)" --secret-string "$BODY" --query Name --output text
fi
echo "Done. Next: scripts/reddit-iam-setup.sh (root profile, ask Dean first)."
