# DEV Dropbox folder browser backend integration

Status: frontend proxy and read-only handler staged on develop; NOT DEPLOYED to Lambda.

Configured DEV resources:
- Lambda: elettro-brand-os-dev-api
- Secret name (Lambda environment): DROPBOX_SECRET_NAME=elettro-brand-os-dev/dropbox
- Secret permission: secretsmanager:GetSecretValue for the Dropbox secret
- Amplify browser: GET /api/dropbox/folders?brand=stashbox
- Proxy target: GET /dropbox/folders?brand=stashbox on existing API Gateway

To finish:
1. Retrieve the deployed DEV API Lambda source safely. Its source is not tracked under the inspected GitHub paths; do not overwrite the existing Lambda handler.
2. Determine actual Dropbox secret JSON keys using the existing sync Lambda source, without logging or exposing secret values.
3. Merge services/worker/src/dropbox-folder-listing.ts logic into the existing Lambda handler/dispatcher and build artifact. Confirm AWS SDK dependency availability.
4. Add GET /dropbox/folders route to the API Gateway that fronts DEV API Lambda. Check API's authorization model; apply the same authenticated origin controls as other asset endpoints before exposing folder metadata.
5. Deploy the updated Lambda and Gateway route. Verify CORS only for authorized application origin if browser makes direct calls. Currently it calls same-origin Amplify proxy.
6. Test GET for stashbox root, subfolders, pagination and rejection of traversal/out-of-brand paths. Do not change files.
7. Test the Amplify Browse Dropbox UI in develop.

The frontend returns an explicit unavailable message until the route is deployed. This is intentional, not confirmation that Dropbox is connected. Do not copy Dropbox access tokens into Amplify.
