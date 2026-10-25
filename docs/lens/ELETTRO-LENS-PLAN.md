# Elettro Lens — build plan (Milestone 1: Stashbox album cover → video overlay)

Status: PLAN, written 2026-10-25 (Opus). Build is done in small PRs into `develop` (Sonnet), each one stopping at a
checkpoint for Dean. Read the repo `CLAUDE.md` first; this file only covers Lens.

## 1. What Lens is

**Elettro Lens** = app-less WebAR inside Elettro OS. Someone opens a branded link (QR on the record sleeve, sticker,
poster) on an iPhone or Android, points the camera at a registered image (album cover, packaging, business card),
and an experience plays on top of it: video first; later 3D, audio, shop links, AI agent.

**It's a paid add-on that's switched on per brand.** Each brand in Elettro OS is either *Lens-enabled* or not. Dean turns it
on by hand for now (no billing). **The upsell UI (locked card, wording, price) is deliberately not built yet**: Dean
2026-10-25, "leave it open". The per-brand switch is built, so an upsell can be added later without rework.
Stashbox is the first enabled brand.

**Milestone 1 (the only goal of this plan):** point a phone camera at a Stashbox album cover → a video overlay
plays, locked to the cover, in the mobile browser. No app install. Managed (target + video) from Elettro OS.

## 2. Engine decision: 8th Wall as a hosted product is gone

Verified 2026-10-25:
- The hosted 8th Wall platform (accounts, cloud editor, image-target tooling) **closed 2026-02-28**. New accounts
  can't be created. Hosted projects die 2027-02-28.
- 8th Wall's engine is now **open source (MIT) at 8thwall.org**, including **Image Targets** and an **Image Target
  Processor CLI**. SLAM (world tracking) is binary-only, and VPS/Maps/Hand Tracking are gone.
- **MindAR** (`mind-ar` on npm, MIT) is the long-standing open WebAR image-tracking library (three.js / A-Frame).
  It compiles targets **in the browser**, so no server is needed to register a target.

**FINAL (Dean, 2026-10-25): 8th Wall open-source engine** (binary + Image Targets, MIT framework), with MindAR as the fallback.
Same hung T-shirt print (Super Funk), iPhone Safari:
- 8th Wall: steady, found/lost 2/1-2, dead on the print after a one-time placement correction; first lock 6.1-7.0 s (includes camera permission + engine start); about 50-75 KB of tracking data per cover.
- MindAR 1.2.5: first lock 3.8-4.8 s, but **very jittery** at its normal smoothing and laggy when smoothed hard; overlay sat off the print; about 0.75 MB per cover.
Calibrated on the same print (8th Wall's final tuning on the phone was x -0.048 / y -0.027 / size 1.140; one later run was slower, 12.3 s with motion blur, so lock time must be re-measured in the real build): MindAR x 0.000 / y -0.040 / size 1.120, first lock 3.6 s, lost 0, **still jittery after calibration**; 8th Wall x -0.053 / y -0.027 / size 1.130, steady.
**Finding:** both engines independently needed about **1.12-1.13x** and about -0.03 to -0.04 in y, so the printed shirt art is not 1:1 with the registered cover file (print bleed/margin or a different crop). Per-trigger placement and size calibration is therefore a first-class product feature (the nudge tool in `/lens`) regardless of engine, and the registered image should be the exact printed art where possible.
Open item: bring 8th Wall's first lock down (about 4 s target): preload only the chunks the image-target path needs (dropping the `slam` preload), keep the engine files on CloudFront, warm the camera on the splash screen.
Both engines remain free and self-hosted; nothing to buy. The rest of the plan is engine-agnostic (the viewer loads a targets file plus a JSON manifest).

**Rekognition is not needed for M1.** Matching happens on the phone, against the brand's compiled target file.
(Rekognition Custom Labels would need training plus an always-on inference endpoint billed per hour.) "AI recognizes"
comes later as a fallback: when nothing tracks, snap a frame → Bedrock (Claude Haiku vision, already used in the OS)
→ "Did you mean *album X*?" (Phase 3).

## 3. Architecture (fully separate from the Publishing Engine)

```
Phone ─▶ lens.elettro.com/<brand>  (static viewer, S3 + CloudFront, public, HTTPS)
          │ loads  /<brand>/manifest.json + targets.mind  (CloudFront, cached)
          │ plays  overlay MP4 (H.264, CloudFront)
          └ POST  /e  scan/play events ─▶ elettro-lens-dev-api (Lambda function URL / HTTP API) ─▶ DynamoDB

Elettro OS (apps/web, signed in) ─▶ /lens pages ─▶ Next API routes ─▶ elettro-lens-dev-api (IAM or connect key)
          register target / attach video / publish  ─▶ writes S3 (lens bucket) + DynamoDB, rebuilds manifest
```

New AWS resources (all `elettro-lens-dev-*`, created by hand; listed in each PR's "AWS changes after merge"):
| Piece | Name | Notes |
|---|---|---|
| Lambda | `elettro-lens-dev-api` | Node 20, **outside the VPC**; no Postgres access |
| DynamoDB | `elettro-lens-dev` (single table) | PK/SK design below, on-demand billing |
| S3 | `elettro-lens-dev-media` | private; viewer files, target files, manifests, overlay videos |
| CloudFront | lens distribution + OAC | serves the bucket; domain `lens.elettro.com` (ACM cert in us-east-1) |
| IAM role | `elettro-lens-dev-api-role` | DynamoDB table + that bucket only, plus CloudFront invalidation |

**Why separate:** the Publishing Engine is live and making money. Lens shares nothing that can break it: no changes to
the dev-api, the workers, EventBridge ticks, or Postgres tables. The only shared code is the web app shell (one nav item)
and the existing auth/brand-scope helpers, which Lens reads and does not modify.

DynamoDB items (single table):
- `PK=BRAND#<slug> SK=ENTITLEMENT` → `{ lensEnabled, plan, enabledAt, enabledBy }`
- `PK=BRAND#<slug> SK=TRIGGER#<id>` → `{ name, imageKey, status: draft|live, quality, setIds[], sourceAssetId? }`. A **trigger** is a registered image (cover, packaging, card).
- `PK=BRAND#<slug> SK=ACTION#<id>` → `{ name, type: video|link|audio|shop|model3d (M1: video + link), videoKey?, url?, fit: crop|fill|float, loop, scale, offset }`. An **action** is what happens.
- `PK=BRAND#<slug> SK=RULE#<id>` → `{ triggerId, actionIds[], order }`. **Many-to-many:** one trigger can fire several actions (video + a "Stream it" button), and many triggers can share one action (two covers → one video, as in the Test 0 Super Funk / I'm Waiting setup).
- `PK=BRAND#<slug> SK=SET#<id>` → `{ name, slug, triggerIds[] }`. A **scan set** is a group of triggers that load together (an album, a campaign, a shelf). See §3a.
- `PK=BRAND#<slug> SK=BUILD#<ts>` → manifest/targets build record (which targets, file keys)
- `PK=EVT#<slug>#<yyyy-mm-dd> SK=<ts>#<rand>` → `{ type: open|camera_ok|camera_denied|found|lost|play|unmute|cta, targetId, ua class, country (from CloudFront header) }` — **no personal data, no IPs stored**, TTL 400 days

### 3a. Many triggers per brand: scan sets (measured 2026-10-25)

MindAR's tracking file grows with every cover (about **0.75 MB each**: 0.83 MB for 1, 1.41 MB for 2, 2.23 MB for 3). 8th Wall's per-cover
data is small (about **50-75 KB** each). A brand with 40 covers cannot make a phone download 30 MB before the camera opens. So:
- The camera loads **one scan set at a time**, never the whole brand. Each QR points at a set (or a single experience).
- Cap: about 10 triggers per set while MindAR is the engine (about 7 MB), much higher with 8th Wall. The engine decision at CP0 must weigh this.
- A trigger can belong to several sets. A brand-wide "scan anything" set is allowed only up to the cap.
- Manifest per set: `<brand>/sets/<setSlug>/manifest.json` + `targets.<engine>`. Publishing a set rebuilds only that set.

S3 layout: `viewer/…` (the built viewer app), `<brand>/targets/<buildId>.mind`, `<brand>/manifest.json`,
`<brand>/images/<targetId>.jpg`, `<brand>/video/<targetId>.mp4`.

## 4. Viewer (the phone experience)

- New package `apps/lens-viewer`: Vite + three.js + engine (MindAR or 8th Wall OSS), **no Next.js** (it has to be static, small, and fast).
- Flow: branded splash (brand logo, "Point your camera at the album cover") → **"Start" tap** (a tap is needed so iOS allows the camera and
  unmuted video) → camera → target found → video plane fades in, sized to the cover → "Tap for sound" chip → optional CTA
  button from the manifest (stream / buy vinyl / Stashbox site).
- iOS rules: `playsinline`, `muted` until a tap, H.264 MP4 ≤ 1080p, `faststart`. Preload the video for the found target only.
- Lost target: keep the video playing in a corner for 2s, then pause (no flicker). **No pulsing, flashing or beat effects** (Dean's rule).
- Fallbacks: camera denied → instructions + still a play button for the video; no WebGL / old browser → plain video page.
- Budget: < 3 s from scan to live camera on 4G; JS ≤ 1.5 MB gzipped, plus the targets file.
- Desktop visitors: QR code "open on your phone".

## 5. Elettro OS section (the management side)

- Nav: new section **"Lens"** with items **Experiences** (`/lens`) and later **Analytics**. Owner: active. Clients:
  the Lens items appear only if one of their brands is Lens-enabled, and are **hidden** otherwise (no upsell card for now,
  see §1). In `/lens`, a brand without Lens shows a plain "Lens isn't enabled for this brand" line, and owners also get the toggle.
  Implement as a per-scope check in the shell rather than a static `CLIENT_NAV` entry, and gate inside the page by
  entitlement as well.
- `/lens` (brand-scoped, follows the header brand dropdown / `?brand=`): list of targets per brand with status, preview
  thumbnail, scans last 7 days, QR/link.
- `/lens/new`: (1) cover image: upload, or pick from that brand's Assets; (2) the target-quality meter (feature
  points; warn on low-detail covers); (3) overlay video: pick from Assets or upload; set loop/scale; (4) preview
  (a desktop webcam test works); (5) **Publish** → rebuild the brand's targets file + manifest → CloudFront invalidation.
- Owner-only: **Brands → Lens toggle** (entitlement on/off per brand). Clients never see the toggle.
- Video from Assets: the Lens API copies the file from Dropbox/asset storage into the lens bucket once, then
  transcodes if needed (M1: require an MP4 H.264 upload or asset, and refuse other formats with a clear message).

### 5a. QR codes (many per brand, each redirectable)

- A brand can have **as many QR codes as it wants.** Each QR is a named record: `{ name, slug, mode, targetSet|actionId|url, isMain, updatedBy }`,
  encoding `https://lens.elettro.com/<brand>/<qr-slug>`. One QR per brand is marked **main** and also answers at `https://lens.elettro.com/<brand>`.
- The printed code never changes; only its destination does. Per QR, in **`/lens/qr`**, the brand chooses:
  - **Scanner**: opens the camera loaded with a chosen **scan set** (e.g. "Dirty Bird album", "Summer merch").
  - **One experience**: opens straight into one action (e.g. the new video).
  - **Web link**: redirect to an `https://` URL (e.g. `https://stashbox.com/radio`).
- **Stashbox's main QR starts as a web link to `https://stashbox.com/radio`** (Dean 2026-10-25). Other Stashbox QRs (one per album, merch, posters) are added later.
- Clients can create and change QRs for their own brands. The Lens on/off switch stays owner-only.
- Every change writes a `QRLOG#<ts>` item (who, what, when). Saving rewrites the QR's manifest and invalidates it.
- Resolution: the viewer reads the QR's manifest on load. In `url` mode it does `location.replace()` before loading any AR code and logs `qr_redirect`.
  Phase 2 can move this to a CloudFront Function for a true 302.
- URL validation: `https://` only, no `javascript:`/`data:`, max 2 KB. A disabled brand's QRs show the "not active" stub.
- `/lens/qr` lists all QRs with a PNG/SVG download, current destination, and scan count; slugs are unique per brand and never reused after deletion.

### 5b. Managing triggers and actions

- **Triggers** (`/lens`): list with thumbnail, quality meter, status, which sets use it. Add by upload or from Assets.
- **Actions** (`/lens/actions`): list of videos/links/buttons. Create once, reuse on many triggers.
- **Connect** (`/lens/new` and the trigger page): pick a trigger, attach one or more actions, set order, fit mode, preview, Publish.
- **Sets** (`/lens/sets`): group triggers; each set shows its download size and warns when near the cap.
- Video from Assets: the Lens API copies the file from Dropbox/asset storage into the lens bucket once, then
  transcodes if needed (M1: require an MP4 H.264 upload or asset, and refuse other formats with a clear message).
- 9:16 video on a square cover: per action fit mode **crop** (fill the cover), **fill** (stretch-free fit with bars) or **float** (stand up above the cover). Chosen from the Test 0 result.

## 6. Lens API (`services/lens-lambda`, routes)

Admin (connect key `x-elettro-connect-key`, same gate pattern as `api-gate.mjs`, copied rather than imported):
`GET /lens/brands/:slug` (entitlement + triggers, actions, rules, sets, QRs) · `PUT /lens/brands/:slug/entitlement` (owner only, enforced in the
web layer) · CRUD for `triggers`, `actions`, `rules`, `sets` and `qr` under `/lens/brands/:slug/…` (create returns presigned S3 PUTs for images/videos) · `POST /lens/brands/:slug/sets/:setId/publish` (accepts the compiled targets file from the browser compiler,
or runs the 8th Wall CLI in the Lambda, writes the manifest, invalidates) · `GET /lens/brands/:slug/stats`.

Public (no key): `POST /e` event ingest. Validate the schema, use brand + target allowlists from the manifest, a rate limit
per IP in memory plus WAF later, and 204. Manifests and media are served by CloudFront, not the Lambda.

Entitlement is enforced **server-side**: publish and target routes refuse brands without `lensEnabled`. A
disabled brand's manifest is replaced by a "not active" stub (no cost, no leak).

## 7. Build sequence and checkpoints

Every PR: branch from `origin/develop`, own worktree `epe-lens-<n>`, PR into `develop`, tests (`node --test`), and the
"AWS changes after merge" list. **STOP at every checkpoint, report to Dean, and wait for his go.**

| # | Work | Checkpoint (Dean) |
|---|---|---|
| **CP0** | **DONE 2026-10-25.** Spike outside the repo (lens-spike folder on Dean's PC, local HTTPS test pages). Both engines ran on Dean's iPhone with three Stashbox covers (Dirty Bird, Super Funk, I'm Waiting) and a printed T-shirt. | Dean chose **8th Wall**. Domain `lens.elettro.com` confirmed. |
| PR1 | `services/lens-lambda` + tests + `build-lens-lambda.yml` (zip artifact, like the others) + `docs/lens/AWS-SETUP.md` (exact CLI for the table, bucket, CloudFront, role). CLAUDE.md §2/§3 updated. | Dean (or root, with Dean's OK) creates the AWS resources and deploys the Lambda. Smoke test with curl. |
| PR2 | `apps/lens-viewer` (static) + deploy script `scripts/lens-deploy-viewer` (build → `aws s3 sync` → invalidate). Seeds the Stashbox manifest by hand. | **Milestone 1 demo**: scan a real Stashbox cover → video. iPhone + Android. |
| PR3 | Elettro OS `/lens` pages + nav + entitlement toggle + triggers, actions, sets and the multi-QR manager `/lens/qr` (§5a, §5b) + Next API routes (server-side calls only, `connectKeyHeaders()`). | Dean registers a second cover himself from the OS, with no code involved, then creates two QRs (one scanner for a set, one web link), switches the web-link QR to the scanner and back, and the same printed QR follows each time. |
| PR4 | Event ingest → Lens stats on `/lens` (scans, plays, unmute rate, QR redirects, by day). | Numbers match a scripted test session. |

Phase 2 (after M1, not in this plan): green-screen/alpha video, CTAs → Shopify, 3D
models (glTF), Publishing Engine tie-in (auto-post the "scan this cover" Reel), per-brand custom domains.
Phase 3: Bedrock "AI recognizes" fallback, AI agent experience, location triggers.

## 8. Guardrails (hard rules for the builder)

1. **Do not modify** `services/dev-api-lambda/**`, any `services/*-lambda` other than `lens-lambda`, EventBridge rules,
   `publishing-formats.mjs`, `init.sql`, or Prisma schema. If Lens seems to need one of these, stop and ask.
2. Allowed shared-code edits: `apps/web/components/app-shell.tsx` (nav + `CLIENT_NAV`), new files under
   `apps/web/app/lens/**` and `apps/web/app/api/lens/**`, `.github/workflows/ci.yml` (test list), root `package.json`
   workspaces (add `apps/lens-viewer`), `CLAUDE.md`.
3. The Amplify build must stay green: `apps/lens-viewer` must not be pulled into the `@elettro/web` build. Run
   `npm run build -w @elettro/web` before every PR.
4. No AWS writes from Claude without Dean's explicit OK for that step. `stashbox-audit` cannot create IAM/DynamoDB/
   CloudFront, so those steps are Dean's (root), written out exactly in `docs/lens/AWS-SETUP.md`.
5. No secrets in code/PRs. The Lens Lambda gets the connect key from env/Secrets Manager like dev-api.
6. Public endpoints store no personal data. Overlay media is public once published, so say so on the publish
   button.
7. Never junction/symlink `node_modules` between worktrees.

## 9. Open decisions for Dean

1. ~~Domain~~ **Decided 2026-10-25: `lens.elettro.com`.** elettro.com DNS is at Namecheap (`dns1/dns2.registrar-servers.com`,
   checked 2026-10-25), so Dean adds two CNAMEs there by hand: the ACM validation record, then `lens` → the CloudFront domain.
   The subdomain doesn't exist yet.
2. Which Stashbox cover(s) and which video for the M1 demo? **Dean is sending the artwork** (hi-res cover file + MP4).
3. ~~QR per brand or per product~~ **Decided 2026-10-25: many QRs per brand**, one marked main (Stashbox main = `https://stashbox.com/radio`),
   each redirectable by the brand (§5a). Brands also manage many triggers and actions (§5b).
4. ~~Upsell wording~~ **Left open (Dean 2026-10-25).** No upsell UI in M1. Revisit after the Milestone 1 demo.

## 11. Integrations: Stashbox Radio and Shopify (Dean 2026-10-25; after Milestone 1)

Both are **read-only links from Lens**; Lens never writes to Radio or to a shop.

**Stashbox Radio (stashbox.com/radio).** Radio is a separate project (`stashbox-radio-*` AWS resources). Its public catalog
(`GET <radio api>/prod-v2/radio/songs`) already lists 89 songs, each with `song_key`, `resolved_artwork_url`, `shop_url`
and a deep link `https://stashbox.com/radio/?song=<song_key>`.
- **Import covers as triggers:** a "Import from Radio" button in `/lens` creates one trigger per song from its artwork (admin picks which).
- **New action type `radio`:** "Play this song on Radio" opens `stashbox.com/radio/?song=<key>`; the scan page can also embed the song player in the overlay later.
- **Reverse link (optional, needs Dean's OK and a separate Radio PR):** a "Scan this cover" hint on a Radio song page.
- Do not modify Radio, its API or its AWS resources from the Lens PRs. If Lens needs a Radio change, stop and ask.

**Same AWS account (confirmed read-only 2026-10-25, account 656260749296):** Radio's prod API is `stashbox-radio-api-prod-api-v2`, its media is the CloudFront
`d34ez960394y8w` in front of bucket `stashbox-radio-media-prod-us-east-1` (dev stack alongside). Same account is not the same project: Lens reads Radio's public
catalog first (no new permissions); a read-only grant on Radio's prod media bucket is added only if the public catalog proves insufficient. Never write to Radio from Lens PRs.

**Default scan experience for Stashbox songs (Dean 2026-10-25, "definitely"):** when someone scans a Stashbox song cover, the overlay plays the video **and** shows two buttons:
**Listen** (opens `https://stashbox.com/radio/?song=<song_key>`) and **Buy** (the song's `shop_url`, or a chosen Shopify product, with `utm_source=lens`).
Radio already supplies `song_key` and `shop_url` for all 89 songs, so importing a song from Radio creates the trigger plus Listen and Buy buttons automatically. The video is the only thing the admin adds.

**Shopify (stashbox.ai and each brand's own shop).** Store feeds are public (`/products.json`; stashbox.ai has 250 products).
- **New action type `shop`:** a product card (image, title, price, **Buy** button) that links to the product page or adds to cart with a `?variant=` link.
  Pick the product from a list loaded from the brand's storefront feed, so price and availability stay current (cached, refreshed on publish).
- **Merch as triggers:** a product's own print art (the T-shirt design, poster, vinyl sleeve) registered as a trigger, so scanning a shirt opens that song's video plus a Buy button.
  This is the printed-art calibration case from Test 0 (see the nudge tool).
- **Attribution:** every Lens link carries `utm_source=lens&utm_medium=ar&utm_campaign=<set>` so scans show up in Shopify analytics.
- Each brand can have a different shop (Stashbox, SolarMeister, ...); the shop is a per-brand setting in `/lens/settings`. Read-only: no orders, customers or inventory touched.
- Shopify admin/Storefront API tokens, if ever needed, go in Secrets Manager under `elettro-lens-dev/`, never in code.

**Button presets per brand (Dean 2026-10-25):** each brand defines its own default buttons in `/lens/settings`, and every trigger inherits them unless it overrides them.
A preset is an ordered list of `{ label, type: link|radio|shop|phone|email, urlTemplate, style }`; templates can use `{song_key}`, `{asset.title}`, `{product.url}` and `{brand}`.
- **Stashbox:** **Listen** (`https://stashbox.com/radio/?song={song_key}`) + **Buy** (song `shop_url` / product).
- **Other brands choose their own**, e.g. SolarMeister: Shop / Get a quote / Call; Neckermann Strom: its own set. Nothing is hard-coded to Stashbox.
- A button with an empty template value (no `song_key`, no product) is skipped, not shown broken.
- Per-trigger overrides: add, remove, reorder or relabel buttons for one cover. Preset changes apply on the next Publish of each set.

**Product links from asset metadata (Dean 2026-10-25):** assets in Elettro OS carry Shopify product links in their metadata. If a trigger's source asset has products, Lens shows a **Buy** button for each; no products, no button.
- Already in the schema (checked in `init.sql`, 2026-10-25): `ShopifyStore` (per brand), `ShopifyProduct` (with `productUrl`), and `Asset.shopifyStoreId` / `Asset.shopifyProductId` (one product per asset today).
  Whether those columns are filled in live data was **not** checked.
- **Isolation kept:** the Lens Lambda has no Postgres access. At **Publish** (and a "Refresh buttons" action), the Elettro OS web server reads the trigger's `sourceAssetId` from the dev-api
  (existing read route, connect key, brand-scoped) and writes the product title, image, price and URL into the Lens manifest as `shop` actions. Lens never queries Postgres or Shopify from the phone path.
- Precedence: buttons added by hand in `/lens` win over metadata-derived ones; metadata-derived ones can be turned off per trigger.
- **If an asset needs several products:** `shopifyProductId` holds one. A multi-product metadata field would be a change to the dev-api / schema, outside the Lens guardrails,
  so it is a separate PR into the dev-api that Dean approves first, then a small Lens change to read it.

Build order: after PR4, one small PR per item: (a) `link`, `radio` and `shop` action types, (b) Radio import, (c) Shopify product picker + UTM, (d) merch-as-trigger flow, (e) buttons from asset metadata (product links).

## 10. Master instruction to give Sonnet (paste at the start of each build session)

> You are building **Elettro Lens** in the Elettro OS repo (`elettro/elettro-brand-os`). Read `CLAUDE.md`, then
> `docs/lens/ELETTRO-LENS-PLAN.md`; it is the spec. Do only the next unchecked step in §7 (state which one before
> starting). Create a fresh worktree from `origin/develop` (`../epe-lens-<n>`, branch `feature/lens-<topic>`), run
> `npm install` in it, build, test, and open a PR into `develop` with a body that has what's new, tests run, and
> "AWS changes after merge". Obey §8 guardrails exactly: never touch the Publishing Engine files listed there; if
> you think you must, stop and ask. Don't do any AWS write, merge, or real-device publish without Dean's explicit OK.
> When the step's checkpoint is reached, **stop** and report: what was built, how Dean tests it on his phone, and
> what's next. Tick the step in §7 in the same PR.
