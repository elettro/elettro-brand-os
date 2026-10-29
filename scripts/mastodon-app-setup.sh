#!/usr/bin/env bash
# Mastodon: register the Elettro OS app on the chosen instance and store its credentials in Secrets Manager.
# Mastodon has no developer portal or review: the app is created with one open API call per instance.
# Run AFTER the Mastodon connect PR is merged and deployed. Uses the `stashbox-audit` profile (see CLAUDE.md section 3).
# Safe to re-run: it makes a NEW app each time and overwrites the secret, so existing brand tokens stop working
# only if the old app is deleted on Mastodon; reconnect the brands after a re-run to be safe.
# Prints no secret values.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-stashbox-audit}" AWS_REGION=us-east-1 AWS_PAGER=""
INSTANCE="${1:-mastodon.social}"
REDIRECT="https://os.elettro.com/api/connections/mastodon/callback"
SECRET=elettro-brand-os-dev/mastodon-oauth

echo "1/2 registering the app on $INSTANCE"
APP=$(curl -fsS -X POST "https://$INSTANCE/api/v1/apps" \
  --data-urlencode "client_name=Elettro OS" \
  --data-urlencode "redirect_uris=$REDIRECT" \
  --data-urlencode "scopes=read:accounts write:statuses write:media" \
  --data-urlencode "website=https://os.elettro.com")

echo "2/2 storing the credentials as $SECRET"
BODY=$(printf '%s' "$APP" | node -e '
  let s = ""; process.stdin.on("data", (c) => s += c).on("end", () => {
    const a = JSON.parse(s);
    if (!a.client_id || !a.client_secret) { console.error("Mastodon sent no client credentials"); process.exit(1); }
    process.stdout.write(JSON.stringify({ instance: process.argv[1], clientId: a.client_id, clientSecret: a.client_secret }));
  });' "$INSTANCE")
if aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "$BODY" --query Name --output text
else
  aws secretsmanager create-secret --name "$SECRET" --description "Elettro OS Mastodon app ($INSTANCE)" --secret-string "$BODY" --query Name --output text
fi
echo "Done. Next: make sure the web app's role can read $SECRET and elettro-brand-os-dev/mastodon/* (see docs/admin/mastodon-connect.md)."
