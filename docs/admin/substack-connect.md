# Substack: connect and publish

First brand: **Elettro** (Substack account `dpalermo@elettro.com`). Added 2026-11-05. Posts go **live on the web**; a scheduled post is never emailed to subscribers.

## Read this first: there is no official API
Substack has no official API for publishing (checked 2026-11-05: its developer API returns public creator profile data only, behind a manual approval form; its official MCP server is read-only). Elettro OS therefore uses Substack's **undocumented internal API**, the same one its website and the open-source `python-substack` package use, authenticated with the **browser session cookie** (`substack.sid`) of a logged-in account.

What that means in practice:
- **No OAuth, no app review.** Connecting = paste the publication address and the cookie on `/connections`.
- **It can break without notice** when Substack changes an endpoint. A failed post says why; the fix is in `services/substack-lambda/index.mjs` (`substack()` calls) and `apps/web/lib/substack-connect.ts`.
- **The cookie expires** on Substack's schedule (not readable by us, so there is no countdown and `tokenExpiresAt` stays NULL). A 401/403 fails the post with "reconnect it on /connections". Posts that were approved stay failed until re-approved.
- **Terms of service:** automated posting through the internal API is not sanctioned by Substack; it has no published policy either way. The account could in theory be flagged. Keep volume modest.
- **Anyone with the cookie has the whole Substack login.** It lives only in Secrets Manager, is never logged, never returned by an API, and never put in git, a PR or chat.

## Pieces
- `services/dev-api-lambda/substack-connect.mjs`: `POST /connections/substack/complete` (needs the connect key). Cookie stored in Secrets Manager `elettro-brand-os-dev/substack/<subdomain>` (`{cookie, subdomain, userId, handle, brand, connectedAt}`); the `SocialAccount` (`destination='substack'`, `externalAccountId` = subdomain, `accountName` = `<subdomain>.substack.com`) is linked to the brand.
- Web: `/api/connections/substack/connect` (POST form: checks the cookie against `substack.com/api/v1/user/profile/self`, then calls the dev-api), `/api/connections/substack/test-post`, `apps/web/lib/substack-connect.ts`, a Substack card on `/connections`. The brand list is `SUBSTACK_BRANDS` (`elettro` only).
- Publisher `services/substack-lambda`: tick claims `substack` / `post`, uploads the picture (`POST /image`), creates a draft (`POST /drafts`), publishes it (`POST /drafts/<id>/publish` with `send:false`), and deletes the draft if publishing is refused. Manual invoke: `{action:"post", brand, title, text, dropboxPath?}`, `{action:"check", brand}` (reads the profile, posts nothing).
- Format: `substack:post` "Photo posts", status `planning` (`publishing-formats.mjs`). Title comes from the planner title, else the first caption line (max 150); the body is the caption (max 1,200 from the copywriter) under one picture. No hashtags.
- Status feed: `substack` is listed only for brands that have a Substack account, so `elettro.com/dash` is unchanged for other brands.

## AWS steps after merge (not in git)
1. Deploy the dev-api (see `deploy-dev-api-lambda.md`); Amplify builds the web app from `develop`.
2. API route: gateway route **and** Lambda permission for `POST /connections/substack/complete` (see `new-api-route.md`).
3. **IAM, root profile only (ask Dean first):** `scripts/substack-iam-setup.sh` adds web-role policy `substack-connect` and dev-api-role policy `substack-connect-secrets`.
4. Dean connects Elettro on `/connections` (publication address + `substack.sid`). To copy the cookie: Chrome, the publication's Substack, F12, Application, Cookies, `substack.sid`.
5. Test post from the Substack card on `/connections` (goes live on the web, not emailed). Get Dean's OK on the content first.
6. Only after that: `scripts/substack-publisher-setup.sh` (root profile, ask Dean first) creates Lambda `elettro-brand-os-dev-substack` and rule `elettro-brand-os-dev-substack-tick` (every 15 minutes, 1 post per tick). The zip comes from the **Build Substack Lambda** artifact.
7. Review lists Substack once the account is connected; set its posts per day there.

## Never verified (written without a live Substack call from this repo)
- The endpoints and payload shapes (`/image` data URL, `/drafts` body incl. `draft_bylines`, `/drafts/<id>/publish`, the `captionedImage` / `image2` node shape, `profile/self` and its `publicationUsers` field) come from `python-substack`'s source, not from a run. The first real test post is the first proof; expect to adjust.
- Whether `/api/v1` calls on `<subdomain>.substack.com` accept the cookie as sent, and whether Substack rate-limits or challenges (captcha) a Lambda IP.
- Whether `substack.sid` alone is enough or other cookies are needed (the connect form accepts a whole `name=value; ...` string too).
- The logo path and colour in `network-logo.tsx` (Simple Icons, from memory).
- IAM steps, the connect route and the Connections card were not run against AWS.

## Unknown / ask Dean
- Elettro's exact publication address (`<something>.substack.com`) and `@handle`.
- Whether any brand may email subscribers (not built; scheduled posts are web-only by design).
- Whether the planner's photo-plus-caption posts suit Substack, or long-form text should be written by hand and queued later.
