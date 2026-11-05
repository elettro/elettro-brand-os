# Snapchat runbook

Status 2026-11-05: **connect, Disconnect, the Review posts-per-day boxes and the publisher `services/snapchat-lambda` are built and unit-tested. Nothing is deployed, and nothing has been tried against live Snap: the API is allowlist-only and our OAuth app is not approved yet.**

## How Snapchat differs from the other networks
- **Allowlist.** The Public Profile API only answers for an OAuth client id that Snap has approved. Request it by emailing
  dev-support@snap.com with the **client id only** (never the secret) and a description of what we do with it.
- **The OAuth app comes from the Snap Business Dashboard** (Ads Manager → Business account → Business Details), **not** the Developer Portal. The org admin makes it.
- **Public Profile only.** Posting works for a Snapchat *Public Profile* (creator/business), never a personal account. The profile returned at login
  (`GET /v1/public_profiles/my_profile`) becomes the publishing target; its id is a UUID and is the `externalAccountId`.
- **Scope** is `snapchat-profile-api`. Snap's reference calls it read-only yet lists the write endpoints; **ask Snap in the allowlist email to confirm it covers posting.**
- **Tokens.** Access tokens last **30 minutes** (one Snap page says 60). The worker renews them every 15-minute tick (when under 20 minutes remain) and again just
  before a post. Snap documents no refresh-token lifetime, so there is no reconnect countdown (`tokenExpiresAt` stays empty). If a refresh is refused, the brand reconnects.

## What a post can be
| Format | Rules | Planner placement |
|---|---|---|
| Story | one vertical MP4, 5-60 s, at least 540x960; no text; lasts 24 h | `story` |
| Spotlight | same video, plus a description of up to 160 characters (hashtags count); Snap reviews it (`SUBMITTED` → `LIVE`/`REJECTED`) | `spotlight` |
| Saved Story | collection of snaps up to 5 minutes | not built |
| Photos | media type `IMAGE` exists but Snap documents no image rules | not built |

Both built formats are `planning` in `services/dev-api-lambda/publishing-formats.mjs` and take 9:16 video up to 60 s. They move to `live` only after one publishes on schedule.

## How the worker posts (from Snap's reference; field encodings not yet exercised against the live API)
1. `POST /v1/public_profiles/{id}/media` with `type`, `name`, a base64 32-byte AES `key` and 16-byte `iv` → `media_id`, `add_path`, `finalize_path`.
2. The video is encrypted with AES-256-CBC, cut into parts of at most 32 MB (35 parts max), each sent to `add_path` as multipart (`action=ADD`, `file`, `part_number`).
3. `POST finalize_path` (`action=FINALIZE`).
4. `POST .../stories {media_id}` or `.../spotlights {media_id, locale, description, skip_save_to_profile}`; retried for about 30 s while Snap finishes processing.
A media object expires after 24 hours. Snap documents no way to delete a post and no media-status endpoint.

## Steps for Dean (blocks everything)
1. Confirm the Snapchat account that owns each brand's Public Profile (a shared team account is best).
2. Make the Snap Business account and the OAuth app (Business Details). Redirect URI: `https://os.elettro.com/api/connections/snapchat/callback`.
3. Email dev-support@snap.com: client id, intended use, and the question about the posting scope.
4. Store the app credentials: secret `elettro-brand-os-dev/snapchat-oauth`, JSON `{"clientId": "...", "clientSecret": "..."}`
   (the web role reads it, like `threads-oauth`; the client id can instead be set as `SNAPCHAT_CLIENT_ID` in Amplify).

## AWS changes after merging (by hand, ask Dean first: root profile for IAM)
1. **Web role**: allow `secretsmanager:GetSecretValue` on `elettro-brand-os-dev/snapchat-oauth*` (same as `threads-oauth`).
2. **dev-api role**: allow `secretsmanager:PutSecretValue` / `CreateSecret` on `elettro-brand-os-dev/snapchat/*`.
3. **API Gateway**: add route `POST /connections/snapchat/complete` on `zkjngy7rdd` plus the Lambda invoke permission (see `docs/admin/new-api-route.md`).
4. **Deploy the dev-api Lambda** from the "Build DEV API Lambda" artifact.
5. **Worker**: after the "Build Snapchat Lambda" run on develop is green, run `scripts/snapchat-publisher-setup.sh` (root profile): creates role, Lambda
   `elettro-brand-os-dev-snapchat` (1024 MB / 300 s), and rule `elettro-brand-os-dev-snapchat-tick` (every 15 minutes).
6. Amplify builds the web app from `develop` on merge.
7. On `/connections` press **Connect Snapchat** for the brand. Then invoke the worker `{"action":"profile","brand":"stashbox"}` to confirm Snap answers.
8. First test post (real account: get Dean's OK on the clip first): `{"action":"post","brand":"stashbox","dropboxPath":"/1---elettro-brand-os/brands/stashbox/…/clip.mp4","kind":"story"}`.

## Dash
`elettro.com/dash` has a Snapchat row. It starts at 5% ("Account + handle confirmed", Dean 2026-11-05) and the dash keeps that as a floor when the live feed
reports less. Brand milestones for the other checkpoints can be set with the IAM-only dev-api action that writes `PlatformMilestone` rows.

## Known gaps
- Disconnect unlinks the brand but cannot revoke at Snap (no revoke endpoint documented); the worker keeps renewing that profile's token until its secret is marked `revokedAt`.
- `SNAPCHAT_BRANDS` in `apps/web/lib/snapchat-connect.ts` (stashbox, elettro, therasbox, solarmeister) is a guess until Dean says which brands have Public Profiles.
- Spotlight review by Snap can reject a post after we report it published (status is not polled).
