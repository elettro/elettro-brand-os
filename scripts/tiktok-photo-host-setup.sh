#!/usr/bin/env bash
# TikTok photo carousels: the image host Elettro OS needs (services/tiktok-lambda).
# TikTok takes photo posts only by URL, and only from a domain/URL prefix verified in the TikTok developer
# portal, so the worker copies each slide to this bucket and gives TikTok https://<DOMAIN>/tiktok/<post>/<n>.jpg.
#
# NOT RUN, NOT TESTED against AWS. Run it by hand after the PR is merged, the TikTok review has a verdict,
# and Dean says go. Uses the root profile `elettro` (it creates an IAM policy and a CloudFront distribution). Safe to re-run.
#
# Before running you need:
#   1. A domain for the images, e.g. media.elettro.com            -> DOMAIN
#   2. An ACM certificate for it IN us-east-1 (status ISSUED)     -> CERT_ARN
# After running (the script prints these):
#   3. DNS: CNAME <DOMAIN> -> the CloudFront domain printed below
#   4. TikTok developer portal: verify the URL prefix https://<DOMAIN>/ for the Elettro OS app
#   5. Deploy the TikTok worker zip (Build TikTok Lambda artifact) so the new code is live
#   Until 3-5 are done, scheduled TikTok carousels fail with a clear message and nothing is posted.
set -euo pipefail
export AWS_PROFILE=elettro AWS_REGION=us-east-1 AWS_PAGER=""
DOMAIN="${DOMAIN:?set DOMAIN, e.g. media.elettro.com}"
CERT_ARN="${CERT_ARN:?set CERT_ARN to an ISSUED us-east-1 ACM certificate for DOMAIN}"
ACCOUNT=656260749296
BUCKET=elettro-brand-os-dev-tiktok-media
FN=elettro-brand-os-dev-tiktok

echo "1/5 bucket $BUCKET (private; CloudFront is the only reader; copies expire after 2 days)"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null; fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-tiktok-copies","Status":"Enabled","Filter":{"Prefix":"tiktok/"},"Expiration":{"Days":2},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'

echo "2/5 CloudFront origin access control + distribution for $DOMAIN"
OAC=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='$BUCKET'].Id | [0]" --output text)
if [ "$OAC" = "None" ] || [ -z "$OAC" ]; then
  OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config \
    "Name=$BUCKET,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text)
fi
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '$DOMAIN')].Id | [0]" --output text)
if [ "$DIST" = "None" ] || [ -z "$DIST" ]; then
  CFG=$(mktemp -p "$HOME")
  cat >"$CFG" <<JSON
{
  "CallerReference": "tiktok-photo-host-$(date +%s)",
  "Comment": "Elettro OS TikTok photo carousel images",
  "Enabled": true,
  "Aliases": { "Quantity": 1, "Items": ["$DOMAIN"] },
  "Origins": { "Quantity": 1, "Items": [{
    "Id": "s3", "DomainName": "$BUCKET.s3.us-east-1.amazonaws.com", "OriginAccessControlId": "$OAC",
    "S3OriginConfig": { "OriginAccessIdentity": "" } }] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3", "ViewerProtocolPolicy": "https-only", "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] },
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6", "Compress": true },
  "ViewerCertificate": { "ACMCertificateArn": "$CERT_ARN", "SSLSupportMethod": "sni-only", "MinimumProtocolVersion": "TLSv1.2_2021" }
}
JSON
  DIST=$(aws cloudfront create-distribution --distribution-config "file://$(cygpath -m "$CFG")" --query Distribution.Id --output text)
  rm -f "$CFG"
fi
CF_DOMAIN=$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)

echo "3/5 bucket policy: only this CloudFront distribution may read"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy '{
  "Version":"2012-10-17",
  "Statement":[{"Sid":"CloudFrontRead","Effect":"Allow","Principal":{"Service":"cloudfront.amazonaws.com"},
    "Action":"s3:GetObject","Resource":"arn:aws:s3:::'"$BUCKET"'/*",
    "Condition":{"StringEquals":{"AWS:SourceArn":"arn:aws:cloudfront::'"$ACCOUNT"':distribution/'"$DIST"'"}}}]}'

echo "4/5 TikTok worker: may write to tiktok/* in the bucket"
ROLE=$(aws lambda get-function-configuration --function-name "$FN" --query Role --output text | sed 's#.*/##')
aws iam put-role-policy --role-name "$ROLE" --policy-name tiktok-photo-host --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::'"$BUCKET"'/tiktok/*"}]}'

echo "5/5 TikTok worker: point it at the host (keeps its other environment variables)"
VARS=$(aws lambda get-function-configuration --function-name "$FN" --query Environment.Variables --output json)
NEW=$(VARS="$VARS" BUCKET="$BUCKET" DOMAIN="$DOMAIN" node -e '
  const v = JSON.parse(process.env.VARS || "null") || {};
  v.TIKTOK_PHOTO_BUCKET = process.env.BUCKET;
  v.TIKTOK_PHOTO_BASE_URL = "https://" + process.env.DOMAIN;
  process.stdout.write(JSON.stringify({ Variables: v }));')
aws lambda update-function-configuration --function-name "$FN" --environment "$NEW" --query LastModified --output text

cat <<EOF

Done. Still to do by hand:
  - DNS: CNAME  $DOMAIN  ->  $CF_DOMAIN
  - TikTok developer portal: verify the URL prefix https://$DOMAIN/ for the Elettro OS app
  - Deploy the TikTok worker zip from the Build TikTok Lambda workflow artifact
  - Check with: aws lambda invoke ... {"action":"tick"} only once a TikTok carousel is approved (it posts as a draft until TikTok audits the app)
EOF
