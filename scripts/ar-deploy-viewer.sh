#!/usr/bin/env bash
# Publish the AR phone viewer to the AR bucket. Needs an AWS profile that can write to the bucket and invalidate CloudFront.
#   AWS_PROFILE=... AR_BUCKET=elettro-ar-dev-media AR_DISTRIBUTION_ID=E... scripts/ar-deploy-viewer.sh
set -euo pipefail
: "${AR_BUCKET:?set AR_BUCKET}" "${AR_DISTRIBUTION_ID:?set AR_DISTRIBUTION_ID}"
cd "$(dirname "$0")/../apps/ar-viewer"
node build.mjs
# Only the viewer and engine folders: never --delete, brand folders (<brand>/...) live in the same bucket.
aws s3 sync dist/viewer "s3://$AR_BUCKET/viewer" --cache-control "public, max-age=300"
# The page itself must never be stale: it carries the version stamps for everything else.
aws s3 cp dist/viewer/index.html "s3://$AR_BUCKET/viewer/index.html" --cache-control "no-cache" --content-type "text/html"
aws s3 sync dist/external "s3://$AR_BUCKET/external" --cache-control "public, max-age=86400"
aws cloudfront create-invalidation --distribution-id "$AR_DISTRIBUTION_ID" --paths "/viewer/*" >/dev/null
echo "viewer published"
