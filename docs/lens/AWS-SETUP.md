# Elettro Lens: AWS setup (PR1)

Run these once, in order, **by Dean** (or by a session with Dean watching). They create new, separate resources named
`elettro-lens-dev-*` in account 656260749296 (us-east-1). They touch **nothing** that the Publishing Engine uses.

- **Which login:** creating tables, roles, buckets and CloudFront needs more than the `stashbox-audit` profile can do
  (it has no IAM or CloudFront/DynamoDB create rights). Use the root profile `elettro` (`aws login`; it expires), as the
  repo `CLAUDE.md` describes. Every command below shows `--profile elettro`.
- **Shell:** the commands are bash (Git Bash). Make an empty scratch folder and run every command from it (they write small
  `lens-*.json` files into the current folder). Replace nothing except where marked `<...>`.
- **Order matters:** 1 table, 2 bucket, 3 certificate (+ DNS record), 4 CloudFront (+ bucket policy), 5 IAM role, 6 Lambda,
  7 DNS record for `lens`, 8 smoke tests.
- Each step says how to check it worked. Stop and ask if any check fails.

```bash
export AWS_PAGER=""
export AWS_PROFILE=elettro
export AWS_REGION=us-east-1
ACCOUNT=656260749296
```

## 1. DynamoDB table `elettro-lens-dev`

```bash
aws dynamodb create-table --table-name elettro-lens-dev \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name elettro-lens-dev
aws dynamodb update-continuous-backups --table-name elettro-lens-dev \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```
Check: `aws dynamodb describe-table --table-name elettro-lens-dev --query Table.TableStatus` prints `"ACTIVE"`.

## 2. S3 bucket `elettro-lens-dev-media` (private)

```bash
aws s3api create-bucket --bucket elettro-lens-dev-media
aws s3api put-public-access-block --bucket elettro-lens-dev-media \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
cat > lens-cors.json <<'EOF'
{ "CORSRules": [ {
  "AllowedOrigins": ["https://os.elettro.com", "http://localhost:3000"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000 } ] }
EOF
aws s3api put-bucket-cors --bucket elettro-lens-dev-media --cors-configuration file://lens-cors.json
```
Check: `aws s3api get-public-access-block --bucket elettro-lens-dev-media` shows all four `true`.
(The browser uploads covers and videos straight to S3 with short-lived presigned links, hence the CORS rule.)

## 3. Certificate for `lens.elettro.com` (must be in us-east-1 for CloudFront)

```bash
CERT=$(aws acm request-certificate --domain-name lens.elettro.com --validation-method DNS \
  --query CertificateArn --output text)
echo "$CERT"
sleep 10
aws acm describe-certificate --certificate-arn "$CERT" \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```
**DNS step (Namecheap, Advanced DNS):** add a **CNAME** record with the `Name` and `Value` printed above.
Namecheap wants the host without the domain: if `Name` is `_abc123.lens.elettro.com.`, enter Host `_abc123.lens`.
Then wait for validation (a few minutes):
```bash
aws acm wait certificate-validated --certificate-arn "$CERT"
```
Check: `aws acm describe-certificate --certificate-arn "$CERT" --query Certificate.Status` prints `"ISSUED"`.

## 4. CloudFront in front of the bucket

4a. Origin access control, and a small function that sends bare brand URLs (`/stashbox`, `/stashbox/main`) to the viewer page
(PR2 uploads the viewer to `viewer/index.html`; any path with a dot, such as `/stashbox/manifest.json`, is served as-is):

```bash
OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config \
  Name=elettro-lens-dev-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query OriginAccessControl.Id --output text)

cat > lens-rewrite.js <<'EOF'
function handler(event) {
  var r = event.request;
  if (r.uri.indexOf('.') === -1) r.uri = '/viewer/index.html';
  return r;
}
EOF
FN_ETAG=$(aws cloudfront create-function --name elettro-lens-dev-rewrite \
  --function-config Comment="send bare lens paths to the viewer",Runtime=cloudfront-js-2.0 \
  --function-code fileb://lens-rewrite.js --query ETag --output text)
FN_ARN=$(aws cloudfront publish-function --name elettro-lens-dev-rewrite --if-match "$FN_ETAG" \
  --query FunctionSummary.FunctionMetadata.FunctionARN --output text)
echo "$OAC" "$FN_ARN"
```

4b. The distribution (uses AWS's managed "CachingOptimized" policy; manifests carry `Cache-Control: max-age=60`, so changes show within a minute even before the invalidation):

```bash
cat > lens-dist.json <<EOF
{
  "CallerReference": "elettro-lens-dev-$(date +%s)",
  "Comment": "Elettro Lens (dev)",
  "Enabled": true,
  "Aliases": { "Quantity": 1, "Items": ["lens.elettro.com"] },
  "Origins": { "Quantity": 1, "Items": [ {
    "Id": "lens-media",
    "DomainName": "elettro-lens-dev-media.s3.us-east-1.amazonaws.com",
    "OriginAccessControlId": "$OAC",
    "S3OriginConfig": { "OriginAccessIdentity": "" } } ] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "lens-media",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "FunctionAssociations": { "Quantity": 1, "Items": [ { "EventType": "viewer-request", "FunctionARN": "$FN_ARN" } ] }
  },
  "ViewerCertificate": { "ACMCertificateArn": "$CERT", "SSLSupportMethod": "sni-only", "MinimumProtocolVersion": "TLSv1.2_2021" },
  "HttpVersion": "http2and3",
  "PriceClass": "PriceClass_100"
}
EOF
DIST=$(aws cloudfront create-distribution --distribution-config file://lens-dist.json \
  --query "Distribution.[Id,DomainName]" --output text)
echo "$DIST"      # prints:  <DISTRIBUTION_ID>  <dxxxx>.cloudfront.net   (write both down)
```

4c. Let only this distribution read the bucket:

```bash
DIST_ID=<DISTRIBUTION_ID from above>
cat > lens-bucket-policy.json <<EOF
{ "Version": "2012-10-17", "Statement": [ {
  "Sid": "AllowLensCloudFrontRead",
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::elettro-lens-dev-media/*",
  "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::$ACCOUNT:distribution/$DIST_ID" } } } ] }
EOF
aws s3api put-bucket-policy --bucket elettro-lens-dev-media --policy file://lens-bucket-policy.json
```
Check: `aws cloudfront get-distribution --id $DIST_ID --query Distribution.Status` becomes `"Deployed"` (about 5 to 10 minutes).

> Everything in the bucket is readable through CloudFront once its URL is known. Object names are random, and published
> manifests are public by design (the plan's guardrail 6). Do not put private files in this bucket.

## 5. IAM role for the Lambda

```bash
cat > lens-trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" } ] }
EOF
aws iam create-role --role-name elettro-lens-dev-api-role --assume-role-policy-document file://lens-trust.json
aws iam attach-role-policy --role-name elettro-lens-dev-api-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > lens-policy.json <<EOF
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "LensTable", "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"],
    "Resource": "arn:aws:dynamodb:us-east-1:$ACCOUNT:table/elettro-lens-dev" },
  { "Sid": "LensMediaObjects", "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::elettro-lens-dev-media/*" },
  { "Sid": "LensMediaList", "Effect": "Allow",
    "Action": "s3:ListBucket",
    "Resource": "arn:aws:s3:::elettro-lens-dev-media" },
  { "Sid": "LensInvalidate", "Effect": "Allow",
    "Action": "cloudfront:CreateInvalidation",
    "Resource": "arn:aws:cloudfront::$ACCOUNT:distribution/$DIST_ID" } ] }
EOF
aws iam put-role-policy --role-name elettro-lens-dev-api-role --policy-name LensDevApi --policy-document file://lens-policy.json
```
(`s3:ListBucket` is there so a missing file answers "not found" instead of "access denied" when publish checks uploads.)

## 6. The Lambda `elettro-lens-dev-api`

Get the zip: after this PR merges, the **Build Lens Lambda** workflow uploads `elettro-lens-dev-api.zip` as a workflow artifact
(`gh run download -R elettro/elettro-brand-os -n elettro-lens-dev-api`). Or build it locally: `cd services/lens-lambda && npm run build`.

Copy the shared connect key from the dev-api into a shell variable **without printing it** (run this in your own terminal):
```bash
KEY=$(aws lambda get-function-configuration --function-name elettro-brand-os-dev-api \
  --query 'Environment.Variables.CONNECTIONS_API_SHARED_SECRET' --output text)
sleep 10   # lets the new IAM role propagate

aws lambda create-function --function-name elettro-lens-dev-api \
  --runtime nodejs24.x --architectures x86_64 --handler index.handler \
  --memory-size 256 --timeout 30 \
  --role arn:aws:iam::$ACCOUNT:role/elettro-lens-dev-api-role \
  --zip-file fileb://elettro-lens-dev-api.zip \
  --environment "Variables={LENS_TABLE=elettro-lens-dev,LENS_BUCKET=elettro-lens-dev-media,LENS_DISTRIBUTION_ID=$DIST_ID,LENS_PUBLIC_BASE_URL=https://lens.elettro.com,CONNECTIONS_API_SHARED_SECRET=$KEY}"
unset KEY
```
The Lambda runs **outside the VPC** (it needs no database), so it answers fast and can't reach Postgres.

Give it a public HTTPS address (a Lambda Function URL; the API checks the connect key itself, exactly like the dev-api):
```bash
aws lambda create-function-url-config --function-name elettro-lens-dev-api --auth-type NONE \
  --query FunctionUrl --output text
aws lambda add-permission --function-name elettro-lens-dev-api --statement-id LensFunctionUrlPublic \
  --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE
aws lambda add-permission --function-name elettro-lens-dev-api --statement-id LensFunctionUrlInvoke \
  --action lambda:InvokeFunction --principal "*"
```
Write down the printed `https://....lambda-url.us-east-1.on.aws/` address: PR3 puts it in the web app's settings as `LENS_API_BASE_URL`.
> If the smoke test below returns `403 Forbidden` from the URL itself (not `401` from the API), AWS wants one of the two
> permissions in a different form; check the Function URL permissions in the Lambda console under Configuration, Permissions.
> This was written without being able to run it, so treat that as the first thing to look at.

## 7. DNS for the public name (Namecheap)

Add a **CNAME**: Host `lens`, Value the CloudFront domain from step 4b (`dxxxx.cloudfront.net`). Namecheap may add a trailing dot; that's fine.
Check: `nslookup lens.elettro.com` resolves to CloudFront addresses (can take a few minutes).

## 8. Smoke tests

```bash
URL=<the lambda-url address from step 6>      # keep the trailing slash off
read -s -p "connect key: " KEY; echo           # type or paste it; it isn't echoed
curl -s "$URL/lens/health" -H "x-elettro-connect-key: $KEY"                       # {"ok":true,"service":"elettro-lens-api"}
curl -s "$URL/lens/health"                                                         # {"ok":false,"error":"Connect key required"}
curl -s -X PUT "$URL/lens/brands/stashbox/entitlement" -H "x-elettro-connect-key: $KEY" \
  -H "x-elettro-actor: dean@elettro.com" -d '{"lensEnabled":true}'                # entitlement with lensEnabled true
curl -s "$URL/lens/brands/stashbox" -H "x-elettro-connect-key: $KEY"              # brand with empty lists
curl -s https://lens.elettro.com/stashbox/manifest.json                            # {"v":1,"brand":"stashbox","enabled":true,...}
unset KEY
```
The last command proves the whole chain: Lambda wrote the manifest to S3, CloudFront serves it at `lens.elettro.com`.
(Opening `https://lens.elettro.com/stashbox` in a browser shows an error until PR2 uploads the viewer; that is expected.)

## Undo (if you need to start over)

Delete in reverse: DNS records, the Lambda and its Function URL, the IAM role policy and role, the CloudFront distribution
(disable first, wait, then delete) and function and OAC, the bucket policy, the bucket (empty it first), the certificate,
the DynamoDB table. All resources are named `elettro-lens-dev-*` or `lens.elettro.com`; nothing else is touched.
