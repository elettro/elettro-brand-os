# Bluesky runbook

Status 2026-10-29: **connect, Review controls and the publisher are built. Nothing is deployed or tested against live Bluesky yet.**

## How Bluesky differs from the other networks
- No developer-portal approval. Any site can register an OAuth client by serving a public **client-metadata** JSON.
  Elettro OS serves it at `https://os.elettro.com/api/connections/bluesky/client-metadata` (that URL is the `client_id`);
  the public keys are at `/api/connections/bluesky/jwks`.
- Confidential client: token requests are signed with an ES256 private key kept in Secrets Manager
  (`elettro-brand-os-dev/bluesky-oauth`, JSON `{"privateJwk": "<jwk string>"}`).
- Scope is `atproto transition:generic` (create posts, upload photos and video).
- Tokens are DPoP-bound and **refresh tokens rotate on every use**. A publisher must store the new session after each
  refresh. Refresh tokens for a confidential client last up to about 180 days (not re-verified), which is the reconnect
  date shown on Connections.

## Posting methods (what a Bluesky post can be)
| Format | Rules | Planner placement |
|---|---|---|
| Text post | 300 graphemes; links, @mentions and #tags are *facets* (byte ranges) the publisher must compute | no placement of its own (text is the caption of every post) |
| Photos | 1-4 images per post, with alt text per image | `post` (1 photo), `carousel` (2-4) |
| Video | 1 video, up to 3 minutes, uploaded through Bluesky's video service | `video` |
| Link card | URL with a preview (title, description, thumbnail blob) | not planned yet |
| Reply / quote / thread | needs a parent record reference | not planned |

A post cannot mix photos and video. These are the `bluesky:*` rows in `services/dev-api-lambda/publishing-formats.mjs`.

## AWS changes after merging step 1 (by hand)
1. **Signing key** (once): `node scripts/bluesky-oauth-setup.mjs --profile stashbox-audit`
   (use `--dry-run` first). It refuses to overwrite an existing secret. If that profile cannot create secrets, ask Dean for root.
2. **Web role**: the Amplify web role must be allowed `secretsmanager:GetSecretValue` on
   `elettro-brand-os-dev/bluesky-oauth*` (the same way it reads `threads-oauth`).
3. **dev-api role**: must be allowed `secretsmanager:PutSecretValue` / `CreateSecret` on `elettro-brand-os-dev/bluesky/*`.
4. **API Gateway**: add route `POST /connections/bluesky/complete` on `zkjngy7rdd` plus the Lambda invoke permission
   (see how `/connections/threads/complete` was done).
5. **Deploy the dev-api Lambda** from the "Build DEV API Lambda" artifact (`update-function-code`).
6. Amplify builds the web app from `develop` on merge. Then open `https://os.elettro.com/api/connections/bluesky/client-metadata`:
   it must return JSON. Bluesky fetches that URL during login.
7. On `/connections`, type a handle and press Connect Bluesky.

## Rules we post under (checked 2026-10-29)
Sources: [Community Guidelines](https://bsky.social/about/support/community-guidelines) (page dated 2025-09-19),
[Developer Guidelines](https://github.com/bluesky-social/bsky-docs/blob/main/docs/support/developer-guidelines.md),
[Bots page](https://github.com/bluesky-social/bsky-docs/blob/main/docs/starter-templates/bots.mdx),
[Rate limits](https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md).
The Terms of Service point to the Community Guidelines for spam and automation and add nothing of their own on promotion.
Bluesky has no paid ads, so promotion here means ordinary posts and links. Re-check these pages when Bluesky updates them.

| Bluesky rule | What it means for us | Where it is enforced |
|---|---|---|
| Post text is at most 300 graphemes; a link counts in full | Long URLs eat the budget. Emoji count as one each. | `copywriter.mjs` (`validateCopy`, counts graphemes for Bluesky), publisher (`postText` never cuts inside a link) |
| Community Guidelines 3.1.1: no spam, no repeated or duplicate posts | Planner already avoids repeating captions; the daily cap is 10 posts per network | planner (`recentCaptions`), `MAX_POSTS_PER_DAY` |
| 3.1.3: no manipulating social signals | No engagement bait, no "like to unlock", no follow-for-follow asks | AI guidance (`intelligence/shared/platforms.md#bluesky`) |
| 3.1.4: commercial content must be clearly identified | Our own brand promoting its own shop, show or release from the brand's account is plainly commercial. Anything sponsored, affiliate or paid must say so. | AI guidance; **Dean to confirm the reading** (see decisions) |
| Developer Guidelines 1.1: no automated or bulk interactions that notify a user (messages, follows, likes, replies) | Scheduled posts never @mention, reply to, like, follow or repost. EPE may suggest replies; a human sends them. | `validateCopy` and the publisher both refuse a scheduled post with an @mention |
| Bots page: scheduled posting to your own account is welcome; use the `bot` self-label as a best practice; interact only when tagged | See decisions | not automated |
| Rate limits: 5,000 points/hour and 35,000/day per account, a post is 3 points; password logins 30 per 5 minutes and 300 per day | Our worst case is 10 posts a day, far inside the limits. OAuth refreshes do not use password logins. | `MAX_POSTS_PER_DAY`, one post per tick |
| 4.1: no advertising of unlawfully sold or regulated goods; 1.3.4: no marketing of gambling, alcohol, tobacco or similar to minors | Not relevant to current brands; the AI guidance lists them as never | AI guidance |
| 3.2: no impersonation, no shared or sold accounts | One real Bluesky account per brand; the connect step refuses an account already linked to another brand | `bluesky-connect.mjs` |

What we add on top, as our own policy: **one link per post**, **at most one hashtag**, and **promotional posts capped at 25%**
of a brand's Bluesky posts by default (`planner-v2-db.mjs`; a brand's own `promotionalMaxShare` wins). The extra posts
go out as plain clips with no link or ask. Driving traffic therefore means: a useful post with one real link, from the records
(`allowedLinks`), in about one post in four, with the rest building the audience that clicks.

### Decisions for Dean
1. **`bot` self-label.** Bluesky asks accounts that post automatically to add it as a best practice. It is not a rule, and it
   tells users (and lets them filter) that the account is automated. Not set. Say if you want it set on a brand's profile.
2. **Disclosure wording: decided 2026-10-29, no "Ad"/"Promo" marker.** Each brand posts only to its own profile, so its promotion is plainly the brand speaking. Sponsored, affiliate or paid content (none exists today) would still have to say so.
3. **Promo share** is 25% by default, matching Threads; change per brand through its `promotionalMaxShare`.

## Publisher (services/bluesky-lambda)
- Invoked only through IAM. EventBridge tick (every 15 min): keep idle logins alive (any login unused for 7 days is refreshed),
  then `claim-due-posts` for `bluesky` (placements `post`, `carousel`, `video`, one post per tick) and `finish-post`.
- Manual invokes (test posts go to **real accounts**: get Dean's OK on the content first):
  `{"action":"post","brand":"stashbox","text":"..."}`, add `"dropboxPaths":[up to 4 images]` or `"dropboxPath":"<one video>"`, optional `"alt"`;
  `{"action":"refresh"}` refreshes every login now.
- Images are re-encoded to JPEG (longest edge 2000 px, quality stepped down) to fit Bluesky's 1,000,000-byte blob limit. Alt text
  defaults to the caption. A video goes: PDS `getServiceAuth` -> `video.bsky.app` `uploadVideo` -> poll `getJobStatus` -> embed the blob.
- Every token refresh rotates the refresh token and is written back to `elettro-brand-os-dev/bluesky/<did>`; if Bluesky rejects a login
  the secret gets `revokedAt` and the post fails with "reconnect it on /connections".
- Not built: mentions as links (an @name stays plain text), link cards, replies/threads.

## AWS changes after the publisher PR merges (root profile, ask Dean first)
1. The step-1 items above must be done first (signing-key secret, API route, dev-api deploy).
2. Wait for **Build Bluesky Lambda** to go green on `develop`, then run `bash scripts/bluesky-publisher-setup.sh`
   (creates role `elettro-brand-os-dev-bluesky-role`, Lambda `elettro-brand-os-dev-bluesky` 1024 MB / 300 s, rule `elettro-brand-os-dev-bluesky-tick`).
3. Connect a Bluesky account on /connections, then a first manual post (text only), then a photo, then a video.
4. A format moves from `planning` to `live` in `publishing-formats.mjs` only after one publishes on schedule.
