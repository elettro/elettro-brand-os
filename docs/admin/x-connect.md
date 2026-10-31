# X: connect and test post

Any brand (every brand except the `google-review` demo) can connect its own X account. One account per brand, no multi-account.
Auth is OAuth 2.0 with PKCE as a confidential client (client id + secret from the X developer portal), scopes
`tweet.read tweet.write users.read offline.access media.write` (`media.write` is not used yet; it is asked now so the future publisher
does not force a reconnect).

X access tokens last about 2 hours and the refresh token **rotates on use** (the old one dies when the new one is issued). The web app
therefore refreshes on demand and writes the new pair back to the account's secret, which is why the web role needs write access to
`elettro-brand-os-dev/x/*`. How long the refresh token itself lives is **not verified**, so there is no reconnect countdown
(`tokenExpiresAt` stays NULL).

## What this PR covers
Connect + Disconnect + a hand-written text test post on `/connections`. **Not built**: a publisher worker, a tick rule, planner support.
`publishing-formats.mjs` keeps X as `integration`; nothing is planned or published to X automatically.

## Pieces
- `services/dev-api-lambda/x-connect.mjs`: `POST /connections/x/complete` (needs the connect key); tokens in Secrets Manager
  `elettro-brand-os-dev/x/<numeric user id>`, account linked to the brand's `SocialAccount` (`destination = 'x'`, `externalAccountId` = user id).
- Web: `/api/connections/x/{start,callback,test-post}`, `apps/web/lib/x-connect.ts`. The web server talks to X (the dev-api has no internet egress).
  The PKCE verifier travels in the signed, HttpOnly state cookie (10 minutes).
- `x` was already a status destination, so it already shows on `elettro.com/dash`; connecting moves it forward.

## Part 1: create the X app (Dean, in the browser; not in git)
1. Sign in at <https://developer.x.com> with the account that should own the app and create a Project and an App (name "Elettro OS").
2. **User authentication settings**: App permissions **Read and write**; Type of App **Web App, Automated App or Bot** (confidential client).
3. **Callback URI**: `https://os.elettro.com/api/connections/x/callback` (exact). Website URL: `https://os.elettro.com`.
4. Copy the OAuth 2.0 **Client ID** and **Client Secret** (not the API key/secret and not the bearer token).
5. Check the app's API plan/credits: posting costs money or needs a paid tier on X. Unknown until Dean looks (see list below).

## Part 2: AWS steps after merge (not in git)
1. Deploy the dev-api (see `deploy-dev-api-lambda.md`); Amplify builds the web app from `develop`.
2. API route: gateway route **and** Lambda permission for `POST /connections/x/complete` (see `new-api-route.md`).
3. `scripts/x-app-setup.sh` stores the client id/secret as `elettro-brand-os-dev/x-oauth` (prompts for them; run with `stashbox-audit`).
4. **IAM, root profile only (ask Dean first):** `scripts/x-iam-setup.sh` adds `x-connect-oauth` to the web role (read `x-oauth-*` and `x/*`,
   **write** `x/*`) and `x-connect-secrets` to the dev-api role (create/put `x/*`). `ListSecrets` on `*` already comes from `linkedin-connect-oauth`.
5. Dean clicks **Connect X** for each brand on `/connections`, signing in to X with that brand's account, then sends one test post.

## Never verified
Written without a live X developer app: the authorize and token exchange, `users/me`, the refresh-token rotation, `POST /2/tweets`, the
IAM access in step 4, and whether X returns a refresh token for this app type have not been run against the real service.

## Unknown / ask Dean
- Which X accounts exist per brand, and who owns the developer app.
- The X API plan/credits and the per-post cost (X moved to pay-per-use; not checked here).
- Refresh-token lifetime (then decide whether to show a reconnect countdown).
