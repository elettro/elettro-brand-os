# Elettro OS (elettro-brand-os) — start here

Elettro OS (a.k.a. EPE, the Elettro Publishing Engine) is a multi-brand publishing system for Dean Palermo's
brands (Stashbox, SolarMeister, Elettro, TheraSbox, Neckermann Strom, WeightLossDavie, Piano Music Soothing, Reggae.Land,
Dean Palermo, Rompe (added 2026-10-31), plus `google-review`, an isolated demo brand for Google's API reviewer). Pipeline:

    Dropbox library → ingest + metadata → approval → Content Pool → planner → platform treatment
      → scheduled publish → PublicationLedger → analytics

State as of 2026-11-01: code re-audited that day against the merged PRs; AWS facts last checked 2026-10-29 (read-only) and 2026-10-31. Everything below
that can drift (status, Lambda list, schedules) is marked **verify**: re-check it against the code or AWS before relying on it.
See section 7 for how this file is kept current.

## 1. Workflow (how changes get made)

- Repo: `github.com/elettro/elettro-brand-os`. Default branch `main` is **stale**; the working trunk is **`develop`**.
- One branch + one git worktree per task, branched from `origin/develop`. Worktrees live next to each other under
  `C:\Users\dpale\` (`epe-<topic>`). Create one with
  `git worktree add ../epe-<topic> -b feature/<topic> origin/develop`.
- Branch names: `feature/…`, `fix/…`, `docs/…`. Open a **PR into `develop`**; Dean reviews and merges. Never push to `develop`/`main`.
- PR body convention (keep it): what's new, tests run, and an **"AWS changes after merge"** list when the change needs
  manual AWS steps. That list is the only record of those steps.
- `git branch -r --no-merged origin/develop` is full of old, abandoned branches. Don't trust it; use
  `gh pr list -R elettro/elettro-brand-os --state all`.
- Never use `junction`/symlinks for `node_modules` between worktrees (a worktree removal followed one and deleted source
  files before). Run `npm install` in each worktree.
- Dates: Dean writes dates as YYMMDD (261011). Code and docs use ISO.

## 2. Architecture

```
Browser ──> Next.js web app (apps/web, AWS Amplify, os.elettro.com)
              │  Cognito sign-in; /api/* routes; MCP/AI gateway for ChatGPT + Claude clients (/api/mcp)
              ▼
           elettro-brand-os-dev-api   (Lambda + HTTP API Gateway, in the VPC, talks to Postgres)
              │  all business logic: assets, planner, review, connections, publishing ledger
              ├── Postgres RDS  elettro-brand-os-dev  (db.t3.micro, PG 18, private)
              ├── Dropbox (library of record), via the dropbox-sync / dropbox-upload Lambdas
              └── invoked by the per-platform worker Lambdas (below) with IAM-only `action`s

EventBridge, every 15 min ──> platform worker Lambda ──> network API
```

- **Web app** `apps/web`: Next.js, hosted on Amplify (`WEB_COMPUTE`, app `d2k28tehm1a8zw`, branch `develop` → `os.elettro.com`).
  Signed-out visitors see the public site at `/welcome` (platforms, features, one-sheets in `public/sheets`, data/privacy, contact CTA); `/` redirects there.
  Pages: `/connections` (connect, test and Disconnect each network), `/planner`, `/review` (approve weeks, posts-per-day, reset,
  reschedule, edit title, carousel settings), `/calendar` (one brand, one month: published posts from `PublicationLedger` plus approved and
  paused posts; Pause/Resume, Edit, Swap = a brand-new post for that slot via `replan-slot`, Remove; backend `calendar.mjs`), `/holidays/<key>` (owner only; a Holidays link in the left rail under Publishing (between Review and Calendar) opening `/holidays`, a page of holiday cards; Halloween first: 3 drafts per brand from `holidays.mjs`, stored in `Brand.settings.holidays.<key>.drafts`; Approve creates one `approved` `ScheduledPost` per connected Instagram/Facebook/Threads/Bluesky/Mastodon account on the holiday date; pictures are the brand's own assets named `<brand>_halloween_<n>_4x5.jpg`, so a draft cannot be approved until its picture is registered), `/assets…`, `/collections`, `/presets`, `/content-pool`, `/decision-brain`, `/ai-gateway`,
  `/ar/**` (AR console), `/epe-upload`, plus dashboard stats.
  **Who sees what:** Cognito owns the accounts. A user in the `owner` group (or the owner email) sees every brand; anyone else sees only
  brands whose `brand-<id>` Cognito group they belong to (`apps/web/lib/brand-access.ts`, PR #181). Client accounts get Assets (view),
  Content Pool, Connections, Review and Calendar for their own brands only. It reaches the API through `apps/web/lib/dev-api.ts`
  (`BRAND_OS_API_BASE_URL`). Amplify build config lives in the Amplify console, not the repo.
- **dev-api Lambda** `services/dev-api-lambda` (a ~1.9k-line `index.mjs` plus about 38 modules): `planner-v2*.mjs` (plan a week),
  `planner-ops.mjs` (claim-due-posts / finish-post / planner-tick), `planner-review.mjs`, `publishing-formats.mjs`
  (**source of truth** for which network/placement is live), `*-connect.mjs` (OAuth connect per network),
  `copywriter.mjs` / `curator.mjs` / `intelligence.mjs` (AI picks and copy), `connection-status.mjs` (feeds the
  elettro.com/dash race).
  **Every HTTP route except `GET /status/connections` and `/status/posts` needs the `x-elettro-connect-key` header**
  (deny-by-default gate in `api-gate.mjs`, which also parses the `?brands=a,b` filter that `/brands`, `/dashboard`, `/assets`
  and `/content-pool` accept; `/assets` also takes `shared=1` to add the creative-assets library). Web server code sends the key via `connectKeyHeaders()` in `apps/web/lib/dev-api-key.ts`;
  never call the dev-api from browser code. The dropbox-sync Lambda's thumbnail route checks the same key.
- **Worker Lambdas** `services/<platform>-lambda`: `threads`, `tiktok`, `pinterest`, `youtube-upload`, `bluesky` (created in AWS 2026-10-29), `mastodon` (created in AWS 2026-10-31), `meta`
  (Instagram + Facebook Reels, feed posts and Stories; Page tokens don't expire, so no renewal) and `linkedin`. Each is invoked only
  through IAM (no HTTP route), runs **outside the VPC** (they need to reach the network APIs), and publishes by calling the
  dev-api's `claim-due-posts` (a worker can pass `placements` to claim only some) then `finish-post`. `meta` was created in AWS and
  published its first scheduled Reels on 2026-10-22. `linkedin` publishes approved photo/video posts to the brand's connected LinkedIn
  account: a **company page** (app "Elettro OS", Community Management API, one page per brand, `urn:li:organization:<id>`; the worker
  renews its token from a refresh token, so there is nothing to reconnect for about a year) or a **personal profile** (app "Elettro OS
  Personal"; the Dean Palermo brand; tokens last 60 days with no refresh, so with an expired login the tick skips and leaves posts approved). Its Lambda `elettro-brand-os-dev-linkedin` and tick rule exist (checked 2026-10-29); connect +
  test-post code is in dev-api/web. Company-page connect and posting are built (PR for 2026-10-29, steps in `docs/admin/connect-linkedin-page.md`);
  not live until the AWS steps there are done and one page post has published. Development tier was granted 2026-10-29; its limits are unknown.
  `gmb` is **not created in AWS yet** (no Lambda, no tick rule).
- **Elettro AR** (WebAR; plan in `docs/ar/ELETTRO-AR-PLAN.md`, setup in `docs/ar/AWS-SETUP.md`): `services/ar-lambda` is the admin API
  (Lambda Function URL, outside the VPC, **no Postgres**, DynamoDB + S3 + CloudFront only; same `x-elettro-connect-key`). It is fully separate from the Publishing Engine:
  AR PRs must not edit the dev-api, the worker Lambdas, the schedules or the schema. Public pages and manifests are served by CloudFront at `ar.elettro.com`, not by the Lambda.
  The phone viewer is the static `apps/ar-viewer` (plain JS, no framework; `scripts/ar-deploy-viewer.sh` publishes it to the AR bucket; not part of the `@elettro/web` build).
  **Status 2026-10-26: AWS resources created and live at `https://ar.elettro.com`** (API Lambda, DynamoDB, bucket, CloudFront; set up with the root profile per the setup guide; brands `stashbox` and `elettro` are enabled with demo data). The viewer is published with `scripts/ar-deploy-viewer.sh`; Lambda code is updated by hand with `aws lambda update-function-code`. `POST /ar/brands/<brand>/triggers/compile` turns an uploaded cover (JPEG/PNG) into a draft trigger with its 8th Wall tracking files (`compile.mjs`, uses `sharp`); the Lambda zip must come from the **Build AR Lambda** workflow artifact because it bundles the Linux `sharp` build, and the function needs about 1024 MB memory and a 60 s timeout. Gotcha: `PUT /ar/brands/<brand>/entitlement` rewrites that brand's `manifest.json`, so seed demo data after it, not before. The earlier `elettro-lens-dev-*` stack was deleted on 2026-10-26; `lens.elettro.com` no longer exists.
  **OS console (merged 2026-10-28, PRs #224-#231):** Experiences, QR codes, Scan sets with Publish set, a cover editor, compile-to-draft-trigger, and AR tools for the
  AI gateway (ChatGPT / Claude). The AR section of the web app (`apps/web/app/ar/**`, `apps/web/app/api/ar/**`, helpers `lib/ar-api.ts` and `lib/ar-access.ts`) calls the AR API server-side with the connect key. It needs `AR_API_BASE_URL` (the AR Lambda's Function URL, no trailing slash) in the Amplify environment; without it the pages say AR is not connected. `AR_PUBLIC_BASE_URL` is optional (default `https://ar.elettro.com`). The owner sees the section for every brand and is the only one who can switch AR on or off; a client sees it only when one of their own brands has AR enabled.
- **Other Lambdas**: `dropbox-sync` (change ingestion), `dropbox-upload` (browser upload links).
- `packages/*` (ai, auth, connectors, database/prisma, media) and `services/worker` are the original Sprint-1 scaffold.
  The live backend is the Lambdas above; check before assuming a package is wired in.
- **`intelligence/`**: the AI's judgment Markdown, loaded at runtime. Rule: *code enforces, intelligence advises, data
  informs.* Posting limits live in config/DB (`CadenceRule`), never only in Markdown. See `intelligence/README.md`.
- **`ScheduledPost.status`** is plain text (no enum): `planned` → `approved` → `publishing` → `published` / `failed` / `missed`, plus
  reviewer states `skipped`, `paused` (Calendar Pause: stays on the calendar, the publisher only claims `approved`, so it is passed over) and
  `removed` (Calendar Remove: hidden, never sent). The planner treats `paused` and `removed` slots as taken, so it never refills them.
- **Data model** (Postgres, quoted camel-case tables): `Brand`, `Asset`, `SocialAccount`, `CadenceRule`, `ScheduledPost`,
  `PublicationLedger`, `BrandStorageRoot`, `StorageConnection`, `Campaign`, `Collection`, `MetadataPreset`, `IntakeBatch`, …
  Schema in `services/dev-api-lambda/init.sql` and `packages/database/prisma`.
- **Dropbox layout**: the library root is `/1---elettro-brand-os/brands/<brand>/…` (migrated 2026-10-17 with a clean-slate reset).
- **Asset kinds** (`Asset.kind`, Postgres enum `AssetKind`): `video`, `image`, `carousel`, `audio`, and `document` (PDF, added 2026-10-29). `.pdf` files in a
  brand's Dropbox folder, direct uploads and the register/intake tools all become `document` assets (`mimeType` `application/pdf`; no thumbnail,
  because Dropbox cannot render one, so the UI shows a glyph; no AI enrichment). The planner **never** picks a document unless a placement's pool rule lists
  `"document"` in `kinds` (`poolRejection` in `planner-v2.mjs`). Nothing lists it yet: LinkedIn's `document` placement still stitches a carousel's images into a PDF.
  The enum value is added in DEV by the IAM-only dev-api action `setup-document-asset-kind-20261029` (`document-asset-kind.mjs`, dry run unless `mode:"apply"`);
  until it has run, the Dropbox sync and uploads fail on any `.pdf`.

## 3. Environments and AWS (account 656260749296, us-east-1)

**Only DEV exists.** There is no production Elettro OS stack. `docs/ENVIRONMENTS.md` still describes a DEV/PROD split and
`dev.app.elettro.com`; that is the original plan, not reality (**verify**).

| Piece | AWS name |
|---|---|
| API | `elettro-brand-os-dev-api` (+ HTTP API) |
| Workers | `elettro-brand-os-dev-{threads,tiktok,pinterest,youtube-upload,meta,linkedin}` (all exist; `bluesky` since 2026-10-29; `gmb` is built in code but not yet created) |
| Dropbox | `elettro-brand-os-dev-{dropbox-sync,dropbox-upload}` |
| Runtime | all Lambdas `nodejs24.x`; dev-api 256 MB / 60 s |
| HTTP API | `zkjngy7rdd`, 18 routes made by hand; each needs a gateway route **and** a Lambda invoke permission (see `docs/admin/new-api-route.md`) |
| DB | RDS `elettro-brand-os-dev` |
| Buckets | `elettro-brand-os-dev-assets`, `elettro-brand-os-dev-thumbnails` |
| Web | Amplify app `d2k28tehm1a8zw` |
| Secrets | Secrets Manager prefix `elettro-brand-os-dev/` (app secrets `*-oauth`; per-account tokens under `<platform>/<id>`) |
| AR (created 2026-10-26) | Lambda `elettro-ar-dev-api`, DynamoDB `elettro-ar-dev`, bucket `elettro-ar-dev-media`, CloudFront for `ar.elettro.com`, role `elettro-ar-dev-api-role` |
| Schedules | EventBridge, all `rate(15 minutes)`, all ENABLED (checked 2026-10-29): `elettro-brand-os-dev-threads-refresh`, `…-tiktok-refresh`, `…-youtube-tick`, `…-meta-tick`, `…-linkedin-tick`, and **`elettro-pinterest-tick`** (different name pattern). `…-bluesky-tick` exists since 2026-10-29. No gmb tick exists yet. |


(**verify** with `aws lambda list-functions` / `aws events list-rules`.)

**The `stashbox-radio-*` and `stashbox-social-*` resources in the same account (including the `stashbox-radio-db2` database and the other two Cognito user pools) are a different project. Don't touch them.** The Elettro OS pool is `User pool - e4j1dk`.

### Deploys are manual
GitHub Actions (`.github/workflows/build-*-lambda.yml`) only **build a zip and upload it as a workflow artifact** on push to
`develop`. They do not deploy. A person (or Claude) downloads the artifact and runs `aws lambda update-function-code`.
dev-api: the **"Build DEV API Lambda"** artifact works and is the simplest route (download with `gh run download`, then `update-function-code`; verified
2026-10-29, steps in `docs/admin/deploy-dev-api-lambda.md`). The local alternative is `npm run build` in `services/dev-api-lambda`
(bundles `intelligence/` and `node_modules`).
**Gotcha:** a new dev-api module file must be added to the zip list in **both** `services/dev-api-lambda/package.json` and `.github/workflows/build-dev-api-lambda.yml` (the workflow's own list is what CI zips; its "Verify packaged handler loads" step fails the build if one is missing; this broke the develop build after #248 until fixed).
Amplify auto-builds the web app from `develop`. After a merge, do the PR's "AWS changes after merge" list by hand.

### Credentials on Dean's machine
- CLI profile **`stashbox-audit`** = IAM user `claude-audit-only` (the name is misleading: it appears to have been created for
  Stashbox Radio auditing on 2026-07-05, per `stashbox-radio/CONTEXT_VERIFIED.md`). It has `ReadOnlyAccess` plus write policies that let it deploy Elettro OS: `EbosDevBrandsCutover`,
  `ElettroDevConnectionsSetup` (inline) and **`ElettroDevPlatformWorkers`** (managed, added 2026-10-22, now v2: update the five
  worker Lambdas, edit the tick rules; policy contents not re-read on 2026-10-29). **Denied on 2026-10-29: `UpdateFunctionCode` on `elettro-brand-os-dev-linkedin`** (the policy predates that Lambda; Dean must upload it or add it to `ElettroDevPlatformWorkers`). Seen working on 2026-10-29: `update-function-code` on the
  dev-api, creating an API Gateway route, reading CloudWatch logs. Dean ran `lambda add-permission` with `elettro`; whether this profile can is untested.
  It is meant to be unable to touch IAM roles, delete anything, or touch Stashbox Radio (not re-tested).
  Use this one. Past sessions also deployed as `root`; avoid that.
- CLI profile `elettro` and the browser console are the **root user** (`aws login`, session expires). Only for rare IAM steps
  (e.g. adding Secrets Manager access to a worker role). Always ask Dean first.
- Known follow-up: split Elettro OS deploys onto their own IAM user and return `claude-audit-only` to read-only.
- Audit trail: console and CLI changes are only in CloudTrail event history (90 days), not in git.

## 4. Publishing status (per `services/dev-api-lambda/publishing-formats.mjs`, 2026-10-29, **verify**)

- **live**: Instagram Reels, Stories and feed photos; Facebook Reels, Stories and photo / wide-video posts (all through
  `services/meta-lambda`); Threads posts; YouTube Shorts and long-form. Merch posts with no caption fail on purpose instead of going out blank.
- **review** (built, waiting on the network): TikTok videos and photo carousels. The Elettro OS TikTok app was submitted for review
  2026-10-21; the TikTok card's default-Allow settings were reverted (#234) until the Direct Post audit passes.
- **planning** (built or test-posting, but nothing has published on schedule yet): Pinterest image and video pins, LinkedIn posts
  (company pages and the Dean Palermo profile), and every carousel format (see below). A format moves to `live` only after one publishes on schedule.
- **Bluesky** (2026-10-29): connect, disconnect, the Review posts-per-day boxes and the publisher `services/bluesky-lambda` are built (text with link/#tag facets, 1-4 photos re-encoded under Bluesky's 1 MB blob limit with `sharp`, one video of up to 100 MB through the video service). Its three formats (`post`, `carousel` up to 4 photos, `video`) are `planning`. Its Lambda `elettro-brand-os-dev-bluesky` and tick rule `elettro-brand-os-dev-bluesky-tick` were created 2026-10-29 (`scripts/bluesky-publisher-setup.sh`, root profile); nothing has published yet. The zip must come from the **Build Bluesky Lambda** artifact (it bundles Linux `sharp`; 1024 MB / 300 s). Setup and AWS steps: `docs/BLUESKY-RUNBOOK.md`. Auth is AT Protocol OAuth (confidential client, DPoP): there is no app review; the "app" is the client-metadata JSON the web app serves plus an ES256 key in the `elettro-brand-os-dev/bluesky-oauth` secret. Each connected account's saved session is `elettro-brand-os-dev/bluesky/<did, : written as _>`. Refresh tokens rotate on use; the publisher writes every refreshed session back to the same secret and moves the reconnect countdown (`set-token-expiry`). Not yet tested against live Bluesky: the first connect attempt (2026-10-29) failed because the library returns the server address with a trailing slash (`aud` is a URL `href`), which the dev-api's check refused; the web callback now sends the bare origin and the API accepts either. Bluesky's published rules and how we enforce them (300-grapheme captions, one link, no automated @mentions, 25% promo cap, Review lists it last) are in `docs/BLUESKY-RUNBOOK.md`.
- **integration** (not live): X. Google Business Profile is allowlisted (261023) and connected per brand. `services/gmb-lambda` publishes approved **Update** posts only (Offers parked, Events wait for a real dated show; Dean 2026-10-31): one 4:3, 3:2 or 16:9 photo, exactly one button (SHOP + product link for a Shopify item, otherwise LEARN_MORE + the brand site, BOOK for shows for hire), a pillar tag, no URL or domain in the caption (cap 1,350), scheduled 9 AM-6 PM on the brand's clock (New York; Berlin for SolarMeister and Neckermann Strom) any day of the week (a late send is fine). Every rule in `GMB_ASSET_SPEC.md` (Dropbox/Claude Skills MD) is a hard gate, plus the 30-day business-majority mix. The Review page's GMB posts-per-day box stores a number (1 a day at most; `savesCadence` in `publishing-formats.mjs`, Dean 2026-10-31) and **Review → Plan now plans GMB Update drafts** through `services/dev-api-lambda/gmb-planner.mjs` (not planner-v2; the format stays `integration` so planner-v2 and its replan never touch GMB): pillar, wording, button and photo (from the brand's `image/4x3|3x2|16x9` folders) per day, saved `planned` for approval. Built-in pillar wording exists for Stashbox (A, B, C, F) and Elettro (B, C); other brands are skipped until they have pillars (`Brand.settings.gmb`). The publisher measures each photo's real size from its header, because the Dropbox sync stores no pixel sizes. Runbook: `docs/admin/gmb-planning.md`. Not yet run against the live DB (not verified). Its Lambda `elettro-brand-os-dev-gmb` and schedule are meant to be created by `scripts/gmb-publisher-setup.sh` (see its PR); **not created as of 2026-10-29**.
- **Mastodon** (2026-10-31): connect, Disconnect, the Review posts-per-day boxes (above LinkedIn) and the publisher `services/mastodon-lambda` are built. Formats `post` (1 photo), `carousel` (2-4 photos) and `video` (up to 99 MB, 1-3 min) are `planning`; text up to 500 characters, up to 3 #tags, public posts, no @mentions, an idempotency key per post. SolarMeister, Neckermann Strom and Stashbox have one profile each on mastodon.social. Tokens never expire (no renewal, no `tokenExpiresAt`). App credentials in secret `elettro-brand-os-dev/mastodon-oauth` (made by `scripts/mastodon-app-setup.sh`), account tokens under `elettro-brand-os-dev/mastodon/<id>@<instance>`. The worker Lambda `elettro-brand-os-dev-mastodon` and its tick rule are made by `scripts/mastodon-publisher-setup.sh` (root profile, ask Dean first); **created 2026-10-31**: role `elettro-brand-os-dev-mastodon-role`, 512 MB / 300 s, rule `elettro-brand-os-dev-mastodon-tick` every 15 minutes, 1 post per tick; the first live post went out the same day. The `/connections/mastodon/complete` route and the connect flow have not been verified against the live service. Details: `docs/admin/mastodon-connect.md`.
- **Adding a brand** (Rompe, 2026-10-31): code lists per `docs/admin/add-a-brand.md`, then create the database row with the IAM-only dev-api action `create-brand-20261031` (`brand-create.mjs`; dry run unless `mode:"apply"`). Review only lists a brand once it is in a network list (`META_BRANDS` etc.); Rompe is in none yet, so it has no Review or Connections tabs until networks are chosen.
- **Duplicate connected rows** (2026-10-31): a reconnect that got a new TikTok open_id used to INSERT a second `SocialAccount` for the same handle (Review showed two TikTok blocks and the planner planned both). TikTok connect now reuses the row with the same handle; to fold existing duplicates run the IAM-only dev-api action `merge-duplicate-accounts-20261031` (`connection-disconnect.mjs`; dry run unless `mode:"apply"`, optional `brand`/`destination`/`keep`). Other networks' connect flows were not checked for the same gap (not verified).
- Token expiry matters: Threads/Pinterest/Meta tokens expire and must be renewed or reconnected by hand if a window is
  missed. Threads renewal is automatic (tick). Connection status/expiry feeds `elettro.com/dash`.
- **Post times** (2026-10-31, `TIME_PROFILES` in `planner-v2.mjs`): the planner ignores a rule's stored window and uses the network's own: LinkedIn weekdays 08:00-20:00, Bluesky and Mastodon 08:00-20:00 with 70% of posts 09:00-17:00, everything else 09:00-21:00 (local time). Each format's posts for a day sit at equal distances in that window (so more or fewer posts re-space them), on any minute of the hour except :00 :15 :30 :45 (each day's row of gaps slides by a seeded phase, then each post moves a few minutes, so the minutes spread around the hour without being exactly balanced), and two formats of one network are pulled at least 7 minutes apart (`separateSlots`). Override per brand with `Brand.settings.planner.postingTimes.<destination>`. Not built yet: post-type timing (booking by day, streaming evenings, merch late night) and a window past 22:00. Workers still tick every 15 minutes, so a post goes out at the next tick after its time. Full write-up: `docs/admin/post-times.md`.
- Each network has a hard daily cap of 14 posts across formats (`MAX_POSTS_PER_DAY`); Review page "posts per day" controls it.
  Posting window 10:00-22:00 ET with a primary window 10:00-17:00 (`posting-window.mjs`, PR #166; that is the default of its one-off IAM-only clamp action. Planned post times come from `TIME_PROFILES`, see Post times above).
- **Carousels** (`placement: "carousel"`: Instagram, Facebook multi-photo, Threads, TikTok photo, LinkedIn multi-image, Pinterest): all `planning`. Instagram carousels and Facebook multi-photo posts publish through `services/meta-lambda` (claimed with `placements` including `carousel`; `claim-due-posts` returns `slides` in order, or `[]` if any slide is gone, which fails the post instead of posting a shorter one); Threads carousels publish through `services/threads-lambda` (its tick now claims `post` and `carousel`); Pinterest carousel Pins publish through `services/pinterest-lambda` (claims `pin`, `video`, `carousel`); LinkedIn multi-image posts and **PDF documents** (`placement: "document"`, 3-20 images stitched into one PDF by `pdf-lib`, posted through LinkedIn's Documents API) publish through `services/linkedin-lambda` (claims `post`, `carousel`, `document`, `text`, `link`, `poll`; its zip carries `node_modules/pdf-lib`). **Hand-written LinkedIn posts** (`text`, `link`, `poll`; formats are `integration`, never planned) are queued from a form on Connections (inside each connected LinkedIn brand card; `components/linkedin-writer.tsx`) (`queue-custom`, `linkedin-custom.mjs`): saved as `planned` with the details in `scoreBreakdown.custom` and a carrier image asset (every ScheduledPost needs an asset; the live schema cannot be changed from here), approved on their card like any post; TikTok photo carousels are built in `services/tiktok-lambda` (claims `video`, `carousel`; status `review`) but need an image host on a TikTok-verified domain (`TIKTOK_PHOTO_BUCKET`, `TIKTOK_PHOTO_BASE_URL`, `scripts/tiktok-photo-host-setup.sh`) and the app review. A format moves to `live` only after one publishes on schedule. The planner builds each from one sector's images (count between the brand's min and max, set on Review, stored in `Brand.settings.carouselSlides`, clamped to the limits in `publishing-formats.mjs`) and stores the slide asset ids in `ScheduledPost.scoreBreakdown.slideIds` (`assetId` is the lead image). `claim-due-posts` never hands a carousel to a worker that does not name `carousel` in `placements`.

## 5. Running and testing

- Tests are plain Node: `node --test tests/<file>` (CI runs an explicit list in `.github/workflows/ci.yml`; add yours there).
  As of 2026-11-01 six test files are **not** in that list, so CI never runs them: `ai-mcp-dropbox-identity`, `ai-mcp-file-hosts`,
  `library-publications`, `list-social-accounts`, `meta-connect`, `post-race` (`planner-review` and `calendar` were added with the Calendar PR). Run them by hand until they are wired in.
  The Python patch-safety test: `python3 -m unittest discover -s tests -p "test_lambda_patch.py"`.
- Local web dev: `npm install` then `npm run dev` (workspace `@elettro/web`). It talks to the live DEV API by default.
- There is no local DB or local Lambda harness. Planner changes can be exercised with
  `npm run simulate-week` in `services/dev-api-lambda`.
- Worker Lambdas support manual invokes, e.g. threads `{ "action": "post", "brand": "…", "text": "…" }`. Test posts go to
  **real accounts**: get Dean's OK on the content first.

## 6. Rules to respect

- **Confirm before anything outward-facing or hard to reverse**: publishing to a real account, changing AWS, merging, deleting.
- Never put secrets, tokens, or keys in code, PRs, logs, or chat. Names of secrets are fine; values are not.
- Don't add a GitHub-merge → AWS auto-deploy without asking Dean; deploys are manual today and nobody has recorded why.
- Keep PRs small and single-purpose, and always include tests and the post-merge AWS list.
- Dean's style: wants plain answers, verified facts over guesses, and says so when something was never checked.
  When state is unknown, check AWS/GitHub rather than guessing.

## 7. Keeping this file current

This file is only useful while it's true. Update it in the **same PR** as the change whenever you:

- add, remove or rename a Lambda, EventBridge rule, bucket, secret prefix or other AWS resource;
- change how code is built or deployed, or which AWS profile or permissions the deploy steps need;
- change a network's publishing status, so that `publishing-formats.mjs` changes;
- add a new service, package or top-level folder, or change the branch and PR workflow.

Keep it to what's hard to see from the code. Don't paste secrets, tokens or key values. If you find
something here that's wrong, fix it, or tell Dean if you can't verify the fix.

**Maintenance rules (Dean, 2026-10-29: keep this proactively current):**

- Every PR that changes anything in the list above includes the `CLAUDE.md` edit, and the PR template has a checkbox for it.
- **At the end of any session that touched AWS, a network's status, brands, routes or deploy steps**, re-read the matching section here and fix it
  before finishing, even if the PR did not need it.
- When a fact here is found wrong, fix it immediately and note the date. When it cannot be checked, say "not verified" instead of leaving it.
- Do a full audit (code, AWS read-only, merged PRs since the last audit) at least every two weeks. **Last full audit: 2026-11-01** (code, workflows, tests and docs re-checked against merged PRs #263-#293; AWS-only facts were not re-verified this run and still carry their 2026-10-29/31 dates).
  `gh pr list -R elettro/elettro-brand-os --state merged --search "merged:>=<last audit date>"` lists what changed.
- Procedures belong in `docs/admin/`, bug history in `docs/bug-fix/`; this file stays the map.

## 8a. Bugs and admin runbooks (read before you guess)

- **Any bug, regression or "it's broken"**: follow `docs/bug-fix/AGENT_WORKFLOW.md`. Search `docs/bug-fix/` and `bugs.json` first,
  keep one `EOS-BUG-####` record per bug, and leave the root cause and repair procedure behind. One tracker for all of Elettro OS;
  AR is an Area, not a separate tracker.
- **Admin tasks** (adding a brand, adding an HTTP route, deploying the dev-api): use the runbooks in `docs/admin/` instead of
  working it out again. If a runbook is missing or wrong, fix it in the same PR and say what was never verified.

## 8. Where to look next

`docs/SYSTEM-SPEC-V1.md` and `docs/ARCHITECTURE.md` (original plan, partly stale), `docs/database-schema.md`,
`docs/PHASE-II-BACKLOG.md`, `docs/PUBLISHING-ENGINE-NEXT-PHASE-PREP.md`, `docs/ai-gateway-v1.md` (MCP/ChatGPT/Claude access),
`docs/claude-push-to-epe.md`, `docs/TIKTOK-RUNBOOK.md`, `docs/ar/` (AR plan + AWS setup), and merged PR bodies (`gh pr view <n> -R elettro/elettro-brand-os`), which are the best
change history.
