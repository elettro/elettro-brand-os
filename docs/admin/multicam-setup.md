# Elettro MultiCam — AWS setup (Phase 1)

Spec: `docs/multicam/ELETTRO-MULTICAM-SPEC.md`. Read-only facts below were checked 2026-11-01 with `stashbox-audit`.
**Done 2026-11-01** (steps 1-5; step 6 not done):
- dev-api deployed from the "Build DEV API Lambda" artifact of merge `73eb452` (CodeSha256 `11/jDQve…`; previous `1gPnC3y…`), `stashbox-audit`.
- Tables created (`setup-multicam-tables-20261101` apply; a second dry run lists all three), `stashbox-audit`.
- Route `POST /multicam` (route id `p2pilxt`) and Lambda permission `multicam-route`, **both with `stashbox-audit`** (add-permission works with it; root not needed).
  Smoke test returns 401 "Connect key required".
- Bucket CORS now lists `https://os.elettro.com` first, then the two old origins; lifecycle rule `multicam-abort-incomplete` (prefix `multicam/`, 2 days).
  **Both needed the root profile**: `stashbox-audit` is denied `s3:PutBucketCORS` and `s3:PutLifecycleConfiguration`.
- Checked live: `/mc/<code>` returns 200, `/multicam` sends a signed-out visitor to login, `/api/multicam/band` with an unknown code returns 404
  "This MultiCam link is not valid" (web → dev-api → Postgres), and an S3 preflight from `https://os.elettro.com` returns `Access-Control-Allow-Origin` and exposes `ETag`.
- **Not yet tested:** a real phone upload (start → parts → complete) and a host session.

## Facts checked

- dev-api `elettro-brand-os-dev-api`: `ASSET_UPLOAD_BUCKET=elettro-brand-os-dev-assets`, no `MULTICAM_BUCKET`, 256 MB / 60 s, in the VPC.
- Role `elettro-brand-os-dev-api-role-ddsp99yg`, inline `ElettroBrandOSDevAssetUploads`: `s3:PutObject` + `s3:GetObject` on
  `elettro-brand-os-dev-assets/*`. That covers create/upload-part/complete multipart (PutObject), HeadObject and presigned GETs.
  **Missing `s3:AbortMultipartUpload`**: cancelling an upload then fails quietly (logged, the clip is still marked aborted); the lifecycle rule below cleans up.
- Bucket CORS: `PUT GET HEAD`, `ExposeHeaders: ETag` (needed: the phone reads each part's ETag), **origins only
  `https://develop.d2k28tehm1a8zw.amplifyapp.com` and `https://dev.app.elettro.com` — not `https://os.elettro.com`.**
  Browser uploads from os.elettro.com are refused until it is added (this also affects the existing direct-upload page).
- No lifecycle configuration on the bucket.

## Steps after merge

1. **Deploy the dev-api** from the "Build DEV API Lambda" artifact (`docs/admin/deploy-dev-api-lambda.md`).
2. **Create the tables** (dry run, then apply):
   ```
   aws lambda invoke --function-name elettro-brand-os-dev-api --cli-binary-format raw-in-base64-out --payload '{"action":"setup-multicam-tables-20261101"}' /dev/stdout --profile stashbox-audit --region us-east-1
   aws lambda invoke --function-name elettro-brand-os-dev-api --cli-binary-format raw-in-base64-out --payload '{"action":"setup-multicam-tables-20261101","mode":"apply"}' /dev/stdout --profile stashbox-audit --region us-east-1
   ```
3. **Route** `POST /multicam` (`docs/admin/new-api-route.md`): gateway route with `stashbox-audit`, Lambda permission
   (statement id `multicam-route`, source arn `.../zkjngy7rdd/*/*/multicam`) with `elettro` (root, ask Dean).
   Smoke test: `curl -s -X POST -d '{}' https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/multicam` → 401 "Connect key required".
4. **Bucket CORS**: add `https://os.elettro.com` to `AllowedOrigins` of `elettro-brand-os-dev-assets`, keeping the rule as it is
   (`put-bucket-cors` replaces the whole configuration, so send all three origins).
5. **Lifecycle** on `elettro-brand-os-dev-assets`: rule `multicam-abort-incomplete`, prefix `multicam/`,
   `AbortIncompleteMultipartUpload.DaysAfterInitiation = 2`. (Expiring the raw clips themselves is Dean's call; not set.)
   `put-bucket-lifecycle-configuration` also replaces the whole configuration; there is none today.
6. Optional (root, ask Dean): add `s3:AbortMultipartUpload` on `elettro-brand-os-dev-assets/multicam/*` to the role's
   `ElettroBrandOSDevAssetUploads` policy.
7. Optional: `MULTICAM_BUCKET` on the dev-api to use a separate bucket (then it needs the same CORS, lifecycle and role access);
   `MULTICAM_PUBLIC_ORIGIN` in Amplify if the QR should point somewhere other than `https://os.elettro.com`.

## First test

Open `/multicam`, start a Stashbox session, scan the QR with a phone, upload a short clip, watch it appear, tap *Make it*,
download the clip. Then *End session* and confirm the QR page says the session has ended.
