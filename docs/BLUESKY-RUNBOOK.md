# Bluesky runbook

Status 2026-10-29: **connect + Review controls built (step 1). No publisher yet.**

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

## Next steps
Step 3: `services/bluesky-lambda` publisher (tick rule, restore session, rotate token, facets, images, video), then flip
the formats to `live` only after one publishes on schedule. Link cards after that.
