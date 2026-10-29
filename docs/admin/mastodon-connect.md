# Mastodon: connect and test post

Brands: `solarmeister` and `neckermann-strom` (German DIY homeowners and flat owners) and `stashbox` (non-promotional music: live clips, song stories). Instance: **mastodon.social**
(chosen 2026-10-29 for size, no approval wait and no rule against business accounts; `mastodon.de` was the German-region
alternative). Each brand uses its own profile; one profile per brand, no multi-account.

Mastodon has no developer portal and no app review. Access tokens never expire and there is no refresh token, so there is no
renewal worker and no reconnect countdown (`tokenExpiresAt` stays NULL; the token ends only if the owner revokes the app).

## What this PR covers
Connect + Disconnect + a hand-written test post on `/connections`. **Not built**: the scheduled-posting worker, a
`publishing-formats.mjs` entry, planner support. Until those exist nothing is planned or published to Mastodon automatically.

## Pieces
- `services/dev-api-lambda/mastodon-connect.mjs`: `POST /connections/mastodon/complete` (needs the connect key); token in Secrets
  Manager `elettro-brand-os-dev/mastodon/<accountId>@<instance>`, account linked to the brand's `SocialAccount` (`destination = 'mastodon'`).
- Web: `/api/connections/mastodon/{start,callback,test-post}`, `apps/web/lib/mastodon-connect.ts`. The web server talks to
  Mastodon (the dev-api has no internet egress). Start uses `force_login=true` so each brand signs in with its own profile.
- Status feed: `mastodon` is listed only for brands that have a Mastodon account, so `elettro.com/dash` and the public feed are unchanged for other brands.

## AWS steps after merge (not in git)
1. Deploy the dev-api (see `deploy-dev-api-lambda.md`); Amplify builds the web app from `develop`.
2. API route: gateway route **and** Lambda permission for `POST /connections/mastodon/complete` (see `new-api-route.md`).
3. `scripts/mastodon-app-setup.sh mastodon.social` registers the app and creates secret `elettro-brand-os-dev/mastodon-oauth`.
4. Check the web app's IAM role can read `elettro-brand-os-dev/mastodon-oauth` and list/read `elettro-brand-os-dev/mastodon/*`
   (it already does this for `linkedin-oauth` and `linkedin/*`; the policy may be per-secret, in which case it needs the root profile: ask Dean first).
5. Dean creates the three profiles on mastodon.social, marks each as an automated account, then clicks Connect on `/connections`.

## Never verified
Written without a live Mastodon account: the OAuth handshake, `force_login`, the idempotent test post and the IAM access in step 4
have not been run against the real service.
