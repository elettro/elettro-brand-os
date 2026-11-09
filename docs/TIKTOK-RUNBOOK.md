# TikTok runbook

How TikTok is wired into Elettro OS and how to deploy and operate it.

## Pieces

| Piece | Where | Deployed by |
|---|---|---|
| TikTok app "Elettro OS" (7698722090002810901), org "Elettro", sandbox "Elettro OS Dev" | developers.tiktok.com | Dean (portal) |
| Connect / Disconnect / Post to TikTok | `apps/web` (`/connections`, `/api/connections/tiktok/*`, `/api/tiktok/creator`) | Amplify, on push to `develop` |
| TikTok card on the Review page | `apps/web/app/review/tiktok-card.tsx`, `planner-review.mjs` `tiktok-approve` | Amplify + dev-api Lambda |
| Connect completion, Disconnect unlink | `services/dev-api-lambda/tiktok-connect.mjs` (`POST /connections/tiktok/complete`) | dev-api Lambda zip |
| Worker: token renewal, planner posts, manual posts, revoke, creator info | `services/tiktok-lambda` → Lambda `elettro-brand-os-dev-tiktok` | **Dean, in the Lambda console** |

Secrets: `elettro-brand-os-dev/tiktok-oauth` (plain JSON `{"clientKey","clientSecret"}`, sandbox keys) and one
`elettro-brand-os-dev/tiktok/<open_id>` per connected account (access + refresh tokens, or only `revokedAt` after a
Disconnect).

## Deploying the worker

1. Take the zip from the **`Build TikTok Lambda` run on `develop`** (Actions → artifact
   `elettro-brand-os-dev-tiktok`), never a zip built from a feature branch: several chats change this worker and the
   develop build is the only one that has all of them.
2. Lambda console → `elettro-brand-os-dev-tiktok` → Code → Upload from → .zip file. The `claude-audit-only` profile
   cannot update this function, its role (`elettro-brand-os-dev-tiktok-role-qhs6hwkp`) or its schedule.
3. Settings: Node.js 24, 256 MB, 120 s. Schedule: EventBridge rule `elettro-brand-os-dev-tiktok-refresh`,
   `rate(15 minutes)` (renew tokens, then one approved TikTok planner post per tick).

Role inline policies: `tiktok-worker-secrets` (read tiktok-oauth, tiktok/*, dropbox; write tiktok/*; list secrets),
`tiktok-worker-planner` (invoke `elettro-brand-os-dev-api`). The Amplify compute role has `tiktok-connect-oauth`
(read tiktok-oauth) and `tiktok-creator-info` (invoke the worker).

## Sandbox rules (until TikTok approves the app)

- Only sandbox **Target Users** can connect (currently @stashboxmusic and @solarmeistershop).
- Direct posts only work to **private** accounts (`unaudited_client_can_only_post_to_private_accounts`).
  @stashboxmusic can't go private (TikTok Shop link), so @solarmeistershop (SolarMeister, private) is the account for
  direct posts and the review demo. Scheduled planner posts go out as inbox drafts (`TIKTOK_TICK_MODE` unset = draft),
  which needs `video.upload`; that scope is not requested while the first review is pending (see Scopes).
- TikTok's in-app "Apps and services permissions" list does not show sandbox apps; use **Disconnect** on
  `/connections` to revoke a grant (the next Connect shows TikTok's consent screen again).

## When a merge into develop doesn't deploy

On 2026-10-21 GitHub sent no `push` events for two merge commits into `develop`, so neither Actions (Lambda builds)
nor Amplify built them, although the Amplify webhook itself was healthy. Check
`gh api repos/elettro/elettro-brand-os/hooks/<id>/deliveries` for a `refs/heads/develop` delivery of the merge commit.
If it's missing: start the Lambda builds with `gh workflow run <workflow>.yml --ref develop`, and start Amplify with
**Run job** on the develop branch (or merge any PR, which sends a fresh push event).

## Scopes

The first app review requested only what the demo showed working: `user.info.basic`, `user.info.profile` (username on
the account card) and `video.publish` (direct posts). `user.info.stats` and `video.list` (analytics) and
`video.upload` is requested again from 2026-11-09: the approver chooses "Post live now" or "Send to my TikTok drafts" on the TikTok card, so the demo shows both. The analytics scopes go into a later review together with a screen that uses them. Changing
`TIKTOK_SCOPES` (apps/web/lib/tiktok-connect.ts) changes TikTok's consent screen; accounts keep the scopes they
granted until they reconnect.

## Direct Post audit UX (2026-11-09)

After the Direct Post audit was rejected ("personal use or internal company use", reference 20261028172418) the
posting flow was checked against TikTok's content-sharing guidelines:

- The TikTok card now plays the exact video before approval (`/api/tiktok/preview`, a short-lived Dropbox link; owner
  or a user in the brand's group, video assets of that brand only).
- The worker refuses a direct post longer than the creator's `max_video_post_duration_sec` (`checkDuration`), as well as the card.
- **Per-post approval for the outside client brand** (`TIKTOK_PER_POST_BRANDS` in `apps/web/lib/tiktok-brand-flow.ts`:
  neckermann-strom only): Review hides the week-wide "Approve all N TikTok posts" box for it, so each TikTok
  post is approved from its own TikTok settings. Other brands keep the week box.
- Already compliant: nickname shown, no default privacy, Comment/Duet/Stitch unchecked, commercial-content disclosure, consent line, nothing added to the caption.

## Live or drafts choice (2026-11-09)

The TikTok card has a choice per post: **Post live now** (Direct Post, `video.publish`, needs who-can-view, interactions and disclosure) or **Send to my TikTok drafts** (`video.upload`; TikTok asks for those settings when the creator finishes it). It is stored as `ScheduledPost.scoreBreakdown.tiktok.sendTo = "draft"` (absent = live); the worker sends a draft whenever that is set, even when `TIKTOK_TICK_MODE=direct`. Accounts connected before this change must reconnect once to grant `video.upload`. Photo carousels are unchanged.
