#!/usr/bin/env bash
# Publish the Lens phone viewer to the Lens bucket. Needs an AWS profile that can write to the bucket and invalidate CloudFront.
#   AWS_PROFILE=... LENS_BUCKET=elettro-lens-dev-media LENS_DISTRIBUTION_ID=E... scripts/lens-deploy-viewer.sh
set -euo pipefail
: "${LENS_BUCKET:?set LENS_BUCKET}" "${LENS_DISTRIBUTION_ID:?set LENS_DISTRIBUTION_ID}"
cd "$(dirname "$0")/../apps/lens-viewer"
node build.mjs
# Only the viewer and engine folders: never --delete, brand folders (<brand>/...) live in the same bucket.
aws s3 sync dist/viewer "s3://$LENS_BUCKET/viewer" --cache-control "public, max-age=300"
# The page itself must never be stale: it carries the version stamps for everything else.
aws s3 cp dist/viewer/index.html "s3://$LENS_BUCKET/viewer/index.html" --cache-control "no-cache" --content-type "text/html"
aws s3 sync dist/external "s3://$LENS_BUCKET/external" --cache-control "public, max-age=86400"
aws cloudfront create-invalidation --distribution-id "$LENS_DISTRIBUTION_ID" --paths "/viewer/*" >/dev/null
echo "viewer published"
