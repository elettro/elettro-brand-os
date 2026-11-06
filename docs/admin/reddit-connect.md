# Reddit: connect and test post

Brands (`REDDIT_BRANDS`, same seven as X): stashbox, elettro, therasbox, solarmeister, weightlossdavie, pianomusicsoothing, neckermann-strom.
One Reddit account per brand. Auth is the standard OAuth 2.0 authorization-code flow (web app, client id + secret) with
`duration=permanent`; scopes `identity submit edit read flair`.

Access tokens last **1 hour**. The refresh token Reddit returns does not rotate and does not expire until the user revokes the app, so
`tokenExpiresAt` stays NULL and there is no reconnect countdown. The web app refreshes on demand and saves the new access token to the
account's secret (so the web role needs write access to `elettro-brand-os-dev/reddit/*`). Every call needs a descriptive `User-Agent`
(`REDDIT_USER_AGENT` in `apps/web/lib/reddit-connect.ts`); Reddit asks for `platform:app id:version (by /u/username)`, so put the owner's Reddit
username into that string once it is known.

## What is built (2026-11-06)
Connect + Disconnect + a hand-written **text** test post on `/connections`. The test post goes to the brand's own profile (`u_<username>`)
unless a subreddit the brand controls is typed in. **Not built:** the scheduled publisher, a `publishing-formats.mjs` entry, Review boxes,
planner support. Nothing is planned or published to Reddit automatically. `reddit` was already a status destination on `elettro.com/dash`.

## Reddit access needs approval first
Since Nov 2025 Reddit's **Responsible Builder Policy** requires manual approval before a new app gets working API tokens (third-party reports
say roughly 1 to 4 weeks; not verified against Reddit's own docs). Commercial use needs a separate agreement with Reddit (no public price
found). Until approved, `Connect Reddit` will fail at the token step. Posting promotional content is also restricted by each subreddit's own
rules, so the plan is: each brand's own profile, plus subreddits that Dean moderates.

Draft text for the approval request (adjust before sending):
- **Use case:** a publishing tool for a small set of brands we own. It posts original text, photos and video that the brand owner has approved to
  the brand's own Reddit profile and to subreddits the brand owner moderates. It does not scrape, collect other users' data, train models, or post
  to subreddits where we are not allowed to.
- **Data used:** only the authenticated account's own identity (`/api/v1/me`) and its own submissions. No user data is stored beyond the OAuth tokens.
- **Volume:** a few posts per day per account; far below 100 queries per minute.
- **Contact / app:** web app, redirect URI `https://os.elettro.com/api/connections/reddit/callback`, privacy policy and contact on os.elettro.com.

## Part 1: create the Reddit app (Dean, in the browser; not in git)
1. Log in to Reddit as the account that should own the app, open <https://www.reddit.com/prefs/apps>, **create another app**.
2. Type **web app**. Redirect URI exactly `https://os.elettro.com/api/connections/reddit/callback`.
3. Submit the approval request (above) if Reddit asks for it. The client id is the short string under the app name; the secret is shown as "secret".

## Part 2: AWS steps after merge (not in git)
1. Deploy the dev-api (`deploy-dev-api-lambda.md`); Amplify builds the web app from `develop`.
2. API route: gateway route **and** Lambda permission for `POST /connections/reddit/complete` (`new-api-route.md`).
3. `scripts/reddit-app-setup.sh` stores the client id/secret as `elettro-brand-os-dev/reddit-oauth` (JSON `{clientId, clientSecret}`; `stashbox-audit`).
4. **IAM, root profile only (ask Dean first):** `scripts/reddit-iam-setup.sh` adds `reddit-connect-oauth` to the web role and
   `reddit-connect-secrets` to the dev-api role.
5. Dean clicks **Connect Reddit** for each brand, signing in with that brand's Reddit account, then sends one test post.

## Never verified
Written without a live Reddit app: the authorize and token exchange (`duration=permanent`), the refresh grant, `GET /api/v1/me`,
`POST /api/submit` (self post to `u_<name>` and to a subreddit), the id/username formats the completion route accepts
(`^[a-z0-9]{1,20}$` and `^[A-Za-z0-9_-]{3,20}$`), and the IAM access in step 4.
