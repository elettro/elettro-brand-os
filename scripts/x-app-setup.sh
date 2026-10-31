#!/usr/bin/env bash
# X: store the Elettro OS developer-app credentials in Secrets Manager.
# X has no API to register an app: create it by hand in the X developer portal first (docs/admin/x-connect.md, part 1),
# then run this. Uses the `stashbox-audit` profile (see CLAUDE.md section 3).
# The client id and secret are read from the environment or prompted for (hidden); nothing is printed or put in argv.
#   X_CLIENT_ID=... X_CLIENT_SECRET=... scripts/x-app-setup.sh      (or just run it and answer the prompts)
# Safe to re-run: it overwrites the secret. Existing brand tokens belong to the old app, so reconnect the brands after.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-stashbox-audit}" AWS_REGION=us-east-1 AWS_PAGER=""
SECRET=elettro-brand-os-dev/x-oauth

if [ -z "${X_CLIENT_ID:-}" ]; then read -r -p "X OAuth 2.0 Client ID: " X_CLIENT_ID; fi
if [ -z "${X_CLIENT_SECRET:-}" ]; then read -r -s -p "X OAuth 2.0 Client Secret: " X_CLIENT_SECRET; echo; fi
if [ -z "$X_CLIENT_ID" ] || [ -z "$X_CLIENT_SECRET" ]; then echo "Both the client id and the client secret are required" >&2; exit 1; fi

BODY=$(node -e 'process.stdout.write(JSON.stringify({ clientId: process.env.X_CLIENT_ID, clientSecret: process.env.X_CLIENT_SECRET }))')
echo "storing the credentials as $SECRET"
if aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "$BODY" --query Name --output text
else
  aws secretsmanager create-secret --name "$SECRET" --description "Elettro OS X app (OAuth 2.0 client)" --secret-string "$BODY" --query Name --output text
fi
echo "Done. Next: make sure the web app's role can read and write $SECRET and elettro-brand-os-dev/x/* (scripts/x-iam-setup.sh)."
