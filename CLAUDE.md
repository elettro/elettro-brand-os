# Elettro OS (elettro-brand-os) — start here

Elettro OS (a.k.a. EPE, the Elettro Publishing Engine) is a multi-brand publishing system for Dean Palermo's
brands (Stashbox, SolarMeister, Elettro, TheraSbox, Neckermann Strom, WeightLossDavie, …). Pipeline:

    Dropbox library → ingest + metadata → approval → Content Pool → planner → platform treatment
      → scheduled publish → PublicationLedger → analytics

State as of 2026-10-22. Everything below that can drift (status, Lambda list, schedules) is marked
**verify**: re-check it against the code or AWS before relying on it. Last-verified source in parentheses.

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
  Pages: `/connections` (connect + test each network), `/planner`, `/review` (approve weeks, posts-per-day),
  `/assets…`, `/content-pool`, `/ai-gateway`. It reaches the API through `apps/web/lib/dev-api.ts`
  (`BRAND_OS_API_BASE_URL`). Amplify build config lives in the Amplify console, not the repo.
- **dev-api Lambda** `services/dev-api-lambda` (one ~6k-line `index.mjs` plus modules): `planner-v2*.mjs` (plan a week),
  `planner-ops.mjs` (claim-due-posts / finish-post / planner-tick), `planner-review.mjs`, `publishing-formats.mjs`
  (**source of truth** for which network/placement is live), `*-connect.mjs` (OAuth connect per network),
  `copywriter.mjs` / `curator.mjs` / `intelligence.mjs` (AI picks and copy), `connection-status.mjs` (feeds the
  elettro.com/dash race).
  **Every HTTP route except `GET /status/connections` and `/status/posts` needs the `x-elettro-connect-key` header**
  (deny-by-default gate in `api-gate.mjs`, which also parses the `?brands=a,b` filter that `/brands`, `/dashboard`, `/assets`
  and `/content-pool` accept; `/assets` also takes `shared=1` to add the creative-assets library). Web server code sends the key via `connectKeyHeaders()` in `apps/web/lib/dev-api-key.ts`;
  never call the dev-api from browser code. The dropbox-sync Lambda's thumbnail route checks the same key.
- **Worker Lambdas** `services/<platform>-lambda`: `threads`, `tiktok`, `pinterest`, `youtube-upload`, `meta`
  (Instagram + Facebook Reels, feed posts and Stories; Page tokens don't expire, so no renewal) and `linkedin`. Each is invoked only
  through IAM (no HTTP route), runs **outside the VPC** (they need to reach the network APIs), and publishes by calling the
  dev-api's `claim-due-posts` (a worker can pass `placements` to claim only some) then `finish-post`. `meta` was created in AWS and
  published its first scheduled Reels on 2026-10-22. `linkedin` publishes approved photo/video posts to the connected member
  profile (member tokens last 60 days with no refresh, so there is no renewal step; with an expired login the tick skips and
  leaves posts approved). Its Lambda and schedule must be created in AWS by hand (see its PR); connect + test-post code is
  in dev-api/web.
- **Elettro AR** (WebAR; plan in `docs/ar/ELETTRO-AR-PLAN.md`, setup in `docs/ar/AWS-SETUP.md`): `services/ar-lambda` is the admin API
  (Lambda Function URL, outside the VPC, **no Postgres**, DynamoDB + S3 + CloudFront only; same `x-elettro-connect-key`). It is fully separate from the Publishing Engine:
  AR PRs must not edit the dev-api, the worker Lambdas, the schedules or the schema. Public pages and manifests are served by CloudFront at `ar.elettro.com`, not by the Lambda.
  The phone viewer is the static `apps/ar-viewer` (plain JS, no framework; `scripts/ar-deploy-viewer.sh` publishes it to the AR bucket; not part of the `@elettro/web` build).
  **Status 2026-10-26: AWS resources created and live at `https://ar.elettro.com`** (API Lambda, DynamoDB, bucket, CloudFront; set up with the root profile per the setup guide; brands `stashbox` and `elettro` are enabled with demo data). The viewer is published with `scripts/ar-deploy-viewer.sh`; Lambda code is updated by hand with `aws lambda update-function-code`. `POST /ar/brands/<brand>/triggers/compile` turns an uploaded cover (JPEG/PNG) into a draft trigger with its 8th Wall tracking files (`compile.mjs`, uses `sharp`); the Lambda zip must come from the **Build AR Lambda** workflow artifact because it bundles the Linux `sharp` build, and the function needs about 1024 MB memory and a 60 s timeout. Gotcha: `PUT /ar/brands/<brand>/entitlement` rewrites that brand's `manifest.json`, so seed demo data after it, not before. The earlier `elettro-lens-dev-*` stack was deleted on 2026-10-26; `lens.elettro.com` no longer exists.
  **OS console (started 2026-10-27):** the AR section of the web app (`apps/web/app/ar/**`, `apps/web/app/api/ar/**`, helpers `lib/ar-api.ts` and `lib/ar-access.ts`) calls the AR API server-side with the connect key. It needs `AR_API_BASE_URL` (the AR Lambda's Function URL, no trailing slash) in the Amplify environment; without it the pages say AR is not connected. `AR_PUBLIC_BASE_URL` is optional (default `https://ar.elettro.com`). The owner sees the section for every brand and is the only one who can switch AR on or off; a client sees it only when one of their own brands has AR enabled.
- **Other Lambdas**: `dropbox-sync` (change ingestion), `dropbox-upload` (browser upload links).
- `packages/*` (ai, auth, connectors, database/prisma, media) and `services/worker` are the original Sprint-1 scaffold.
  The live backend is the Lambdas above; check before assuming a package is wired in.
- **`intelligence/`**: the AI's judgment Markdown, loaded at runtime. Rule: *code enforces, intelligence advises, data
  informs.* Posting limits live in config/DB (`CadenceRule`), never only in Markdown. See `intelligence/README.md`.
- **Data model** (Postgres, quoted camel-case tables): `Brand`, `Asset`, `SocialAccount`, `CadenceRule`, `ScheduledPost`,
  `PublicationLedger`, `BrandStorageRoot`, `StorageConnection`, `Campaign`, `Collection`, `MetadataPreset`, `IntakeBatch`, …
  Schema in `services/dev-api-lambda/init.sql` and `packages/database/prisma`.
- **Dropbox layout**: the library root is `/1---elettro-brand-os/brands/<brand>/…` (migrated 2026-10-17 with a clean-slate reset).

## 3. Environments and AWS (account 656260749296, us-east-1)

**Only DEV exists.** There is no production Elettro OS stack. `docs/ENVIRONMENTS.md` still describes a DEV/PROD split and
`dev.app.elettro.com`; that is the original plan, not reality (**verify**).

| Piece | AWS name |
|---|---|
| API | `elettro-brand-os-dev-api` (+ HTTP API) |
| Workers | `elettro-brand-os-dev-{threads,tiktok,pinterest,youtube-upload,meta,linkedin,gmb}` (`linkedin` and `gmb` once created) |
| Dropbox | `elettro-brand-os-dev-{dropbox-sync,dropbox-upload}` |
| DB | RDS `elettro-brand-os-dev` |
| Buckets | `elettro-brand-os-dev-assets`, `elettro-brand-os-dev-thumbnails` |
| Web | Amplify app `d2k28tehm1a8zw` |
| Secrets | Secrets Manager prefix `elettro-brand-os-dev/` (app secrets `*-oauth`; per-account tokens under `<platform>/<id>`) |
| AR (created 2026-10-26) | Lambda `elettro-ar-dev-api`, DynamoDB `elettro-ar-dev`, bucket `elettro-ar-dev-media`, CloudFront for `ar.elettro.com`, role `elettro-ar-dev-api-role` |
| Schedules | EventBridge, all `rate(15 minutes)`: `elettro-brand-os-dev-threads-refresh`, `…-tiktok-refresh`, `…-youtube-tick`, `…-gmb-tick`, and **`elettro-pinterest-tick`** (different name pattern), `elettro-brand-os-dev-meta-tick` |


(**verify** with `aws lambda list-functions` / `aws events list-rules`.)

**The `stashbox-radio-*` and `stashbox-social-*` resources in the same account are a different project. Don't touch them.**

### Deploys are manual
GitHub Actions (`.github/workflows/build-*-lambda.yml`) only **build a zip and upload it as a workflow artifact** on push to
`develop`. They do not deploy. A person (or Claude) downloads the artifact and runs `aws lambda update-function-code`.
dev-api is built locally: `npm run build` in `services/dev-api-lambda` (bundles `intelligence/` and `node_modules`).
Amplify auto-builds the web app from `develop`. After a merge, do the PR's "AWS changes after merge" list by hand.

### Credentials on Dean's machine
- CLI profile **`stashbox-audit`** = IAM user `claude-audit-only` (the name is misleading: it appears to have been created for
  Stashbox Radio auditing on 2026-07-05, per `stashbox-radio/CONTEXT_VERIFIED.md`). It has `ReadOnlyAccess` plus write policies that let it deploy Elettro OS: `EbosDevBrandsCutover`,
  `ElettroDevConnectionsSetup` (inline) and **`ElettroDevPlatformWorkers`** (managed, added 2026-10-22, now v2: update the five
  worker Lambdas, edit the five tick rules). It **cannot** touch IAM roles, delete anything, or touch Stashbox Radio.
  Use this one. Past sessions also deployed as `root`; avoid that.
- CLI profile `elettro` and the browser console are the **root user** (`aws login`, session expires). Only for rare IAM steps
  (e.g. adding Secrets Manager access to a worker role). Always ask Dean first.
- Known follow-up: split Elettro OS deploys onto their own IAM user and return `claude-audit-only` to read-only.
- Audit trail: console and CLI changes are only in CloudTrail event history (90 days), not in git.

## 4. Publishing status (per `services/dev-api-lambda/publishing-formats.mjs`, 2026-10-22, **verify**)

- **live**: Threads posts, YouTube Shorts, YouTube long-form, Instagram Reels, Facebook Reels (first scheduled
  publishes 2026-10-22). Merch posts with no caption fail on purpose instead of going out blank.
- **review** (built, waiting on the network): TikTok videos. Elettro OS TikTok app was submitted for review 2026-10-21.
- **planning** (test posts work, scheduled auto-publish not built or not enabled): Instagram, Facebook, LinkedIn, Pinterest
  (Pinterest posting was merged in PR #144; re-check whether it is now live). Instagram/Facebook feed photos and wide
  videos are handled by the same worker (`services/meta-lambda`) but stay `planning` until one publishes on schedule.
  Stories are not built.
- **integration** (not live): X. Google Business Profile is allowlisted (261023) and connected per brand. `services/gmb-lambda` publishes approved Update and Offer posts (one photo, one button, a pillar tag; every rule in `GMB_ASSET_SPEC.md` is a hard gate, plus the 30-day business-majority mix). Posts are queued by hand and the planner does not plan them (the format stays `integration`) until the business-intelligence layer and per-brand content policies exist. Its Lambda `elettro-brand-os-dev-gmb` and schedule are created by `scripts/gmb-publisher-setup.sh` (see its PR).
- Token expiry matters: Threads/Pinterest/Meta tokens expire and must be renewed or reconnected by hand if a window is
  missed. Threads renewal is automatic (tick). Connection status/expiry feeds `elettro.com/dash`.
- Each network has a hard daily cap of 10 posts across formats; Review page "posts per day" controls it.
- **Carousels** (`placement: "carousel"`: Instagram, Facebook multi-photo, Threads, TikTok photo, LinkedIn multi-image, Pinterest): all `planning`. Instagram carousels and Facebook multi-photo posts publish through `services/meta-lambda` (claimed with `placements` including `carousel`; `claim-due-posts` returns `slides` in order, or `[]` if any slide is gone, which fails the post instead of posting a shorter one); Threads carousels publish through `services/threads-lambda` (its tick now claims `post` and `carousel`); Pinterest carousel Pins publish through `services/pinterest-lambda` (claims `pin`, `video`, `carousel`); LinkedIn multi-image posts publish through `services/linkedin-lambda` (claims `post`, `carousel`); TikTok photo carousels are built in `services/tiktok-lambda` (claims `video`, `carousel`; status `review`) but need an image host on a TikTok-verified domain (`TIKTOK_PHOTO_BUCKET`, `TIKTOK_PHOTO_BASE_URL`, `scripts/tiktok-photo-host-setup.sh`) and the app review. A format moves to `live` only after one publishes on schedule. The planner builds each from one sector's images (count between the brand's min and max, set on Review, stored in `Brand.settings.carouselSlides`, clamped to the limits in `publishing-formats.mjs`) and stores the slide asset ids in `ScheduledPost.scoreBreakdown.slideIds` (`assetId` is the lead image). `claim-due-posts` never hands a carousel to a worker that does not name `carousel` in `placements`.

## 5. Running and testing

- Tests are plain Node: `node --test tests/<file>` (CI runs a list in `.github/workflows/ci.yml`; add yours there).
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

## 8. Where to look next

`docs/SYSTEM-SPEC-V1.md` and `docs/ARCHITECTURE.md` (original plan, partly stale), `docs/database-schema.md`,
`docs/PHASE-II-BACKLOG.md`, `docs/PUBLISHING-ENGINE-NEXT-PHASE-PREP.md`, `docs/ai-gateway-v1.md` (MCP/ChatGPT/Claude access),
`docs/claude-push-to-epe.md`, and merged PR bodies (`gh pr view <n> -R elettro/elettro-brand-os`), which are the best
change history.
