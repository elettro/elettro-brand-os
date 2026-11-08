# Tracked links: clicks and store events per post

Built 2026-11-07 for **Stashbox (stashbox.ai)** first; SolarMeister follows once Stashbox is proven. Code:
`services/dev-api-lambda/link-tracking.mjs`, web `apps/web/lib/link-hosts.ts`, `lib/link-tracking.ts`,
`app/api/l/[code]`, `app/api/link-events`, `middleware.ts`, Shopify pixel `docs/admin/link-tracking/stashbox-pixel.js`.

## What it does

When a worker claims a post (`claim-due-posts`), a link in it to one of the brand's own sites gets a 7-character code:

| Network | What happens to the link |
|---|---|
| Threads, Bluesky, Mastodon, Facebook, YouTube, LinkedIn (links in the caption) | replaced by `https://go.stashbox.ai/<code>` (only if the caption does not get longer) |
| Pinterest (pin link), GMB (button) | keeps its own address, gains `?eo=<code>&utm_source=…&utm_medium=social&utm_campaign=<sector>&utm_content=<code>` (Pinterest and GMB distrust redirects; GMB's SHOP button must point at `/products/…`) |
| X | nothing: X posts carry no URLs |
| Instagram | nothing in the caption (it can't click); the **bio-link page** `go.stashbox.ai/bio` carries the tracked links (see below) |

Then, per post:

1. **click**: `go.stashbox.ai/<code>` → `/api/l/<code>` → dev-api `POST /links {action:"click"}` logs it and answers the store
   page with `?eo=<code>` + utm fields → 302. Link-preview robots (Mastodon servers fetch every link they see, Facebook,
   Slack, Bluesky cards …) and empty user agents are logged as `preview`, never `click`.
2. **page_view / product_view / add_to_cart / checkout_started / purchase**: the Shopify custom pixel sees `?eo=<code>`,
   keeps it for 7 days and posts each event to `go.stashbox.ai/api/link-events` → dev-api `{action:"event"}`. Unknown codes
   are ignored; Shopify's event id (the order id for purchases) stops double counting.
3. Shopify itself also keeps the utm fields on the order (Analytics → Reports → Sessions/Sales by UTM), a second source.

**What counts as a click (2026-11-07, after the first post showed 11 clicks for one tester):** only a GET page navigation that sends browser languages and, when the browser sends them, `Sec-Fetch-Mode: navigate`. HEAD requests, prefetches (`Sec-Purpose`), link checkers and preview robots are `preview`. Each event keeps a coarse label (`client`, e.g. `GET ios safari lang fetch:navigate`), never the full user agent or IP. `POST /links {action:"events", code}` lists one link's events with time, kind, referring site and label. The column is added by re-running `setup-link-tracking-20261107` with `mode:"apply"`.

Stored: `TrackedLink` (code, brand, post, network, real address, mode `short`/`direct`) and `LinkEvent` (kind, product
title, value, currency, referrer host, time). **No IP, user agent, name, email or address is stored.** The post's
`scoreBreakdown.tracking` keeps `{code, mode, targetUrl, shortUrl}` and `generatedCaption` holds the caption as posted.

Tracking is **off** for a brand unless `Brand.settings.linkTracking = {enabled: true, host, origins?}`; without `origins`
it tracks links to the planner's `links.merchStore` and `links.site`. A tracking error never blocks a post (it is logged
`[link-tracking] skipped a post` and the post goes out with its normal link).

Read the numbers: dev-api `POST /links {action:"stats", brandSlug:"stashbox", days:28}` (connect key) → per-post funnel +
totals. The Analytics page will read the same thing.

## Setup (Stashbox) — order matters

1. **Merge + deploy the dev-api** (`docs/admin/deploy-dev-api-lambda.md`). The web app deploys itself from `develop`.
2. **Tables + switch on Stashbox** (IAM-only action, dry run first):
   ```
   aws lambda invoke --function-name elettro-brand-os-dev-api --cli-binary-format raw-in-base64-out --profile stashbox-audit --region us-east-1 \
     --payload '{"action":"setup-link-tracking-20261107","brandSlug":"stashbox","host":"go.stashbox.ai"}' out.json && cat out.json
   ```
   Check `effective.origins` is `["https://stashbox.ai","https://stashbox.com"]`, then re-run with `"mode":"apply"`.
   Until step 4 works, posts claimed after this would carry go.stashbox.ai links that do not resolve: **do step 2 last if
   DNS is not ready**, or apply the tables now and the brand switch later (`"enabled":false`).
3. **Route** `POST /links` on HTTP API `zkjngy7rdd` + Lambda permission (`docs/admin/new-api-route.md`):
   ```
   aws apigatewayv2 create-route --api-id zkjngy7rdd --route-key "POST /links" --target integrations/h25cb92 --region us-east-1 --profile stashbox-audit
   aws lambda add-permission --function-name elettro-brand-os-dev-api --statement-id links-route --action lambda:InvokeFunction \
     --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:656260749296:zkjngy7rdd/*/*/links" --profile stashbox-audit --region us-east-1
   ```
   Smoke: `curl -s -X POST -d '{}' https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/links` → 401 "Connect key required".
4. **Domain `go.stashbox.ai` on the Amplify app** `d2k28tehm1a8zw`: Amplify console → Hosting → Custom domains → Add
   domain `stashbox.ai`, **only** the subdomain `go` → branch `develop` (do not map the root: stashbox.ai is the Shopify store).
   Amplify shows two DNS records (an ACM validation CNAME and `go` → the Amplify CloudFront name); add both where stashbox.ai's
   DNS is managed (check Shopify → Settings → Domains first: if Shopify manages the DNS, add them there). Wait for "Available".
   Smoke: `curl -sI https://go.stashbox.ai/` → 302 to https://stashbox.ai; `curl -sI https://go.stashbox.ai/zzzzzzz` → 302 to
   https://stashbox.ai (unknown code).
5. **Shopify pixel**: stashbox.ai admin → Settings → Customer events → Add custom pixel `Elettro OS links` → paste
   `docs/admin/link-tracking/stashbox-pixel.js` → Customer privacy: Permission "Required" with only Analytics ticked; Data sale "does not qualify" → Save → **Connect**.
6. **First real check**: when the next tracked Threads/Bluesky/Mastodon post goes out, open its short link on a phone,
   view the product, add to cart (no need to buy), then `{action:"stats", brandSlug:"stashbox", days:1}` should show
   1 click, 1 page_view, 1 product_view, 1 add_to_cart for that code.

## Instagram bio-link page (2026-11-08, Stashbox first; not deployed: not verified)

Instagram captions cannot hold clickable links, so the profile's one link points at `https://go.stashbox.ai/bio`. The page is plain
server-rendered HTML (`apps/web/app/link-bio/page.tsx`, no client script, so it opens fast in Instagram's in-app browser). Middleware
rewrites `/bio` on a link host that has `bio: true` in `LINK_HOSTS`; `/` on the host still goes to the store.

- **Buttons**: set in `Brand.settings.linkTracking.bio.buttons` (`{key, label, url}`, https only, max 4; first one is the orange primary). Each gets
  a `TrackedLink` with `scheduledPostId` NULL and `placement = "bio:<key>"` (a changed `url` updates the same code).
- **Tiles**: the brand's newest **published Instagram posts** whose `scoreBreakdown.copy.primaryLink` is on one of its tracked origins, one tile per
  product page (query string dropped; newest post wins), up to `bio.max` (default 6, 2-12). Each post gets one `TrackedLink` (destination
  `instagram`), made the first time the page is built and reused forever, so a tile's clicks stay with its post and show in `{action:"stats"}`
  next to every other network. A tap goes `/<code>` → `/api/l/<code>` → the product page with `?eo=<code>&utm_source=instagram…`, so the
  Shopify pixel funnel works the same.
- **Pictures**: `/api/bio-img/<code>` asks the dev-api (`bio-image`) for the Dropbox path of that tile's asset and fetches the Dropbox thumbnail with the
  connect key. Only a code that belongs to a published Instagram post answers; anything else is 404. Cached a day in the browser.
- **API**: `POST /links {action:"bio", brandSlug}` and `{action:"bio-image", code}` (connect key, same route as the rest).
- **Cost**: a page view is one Lambda call plus a few reads; the first view of a new post adds one insert. No new AWS resource.
- **Caption convention**: nothing writes "link in bio" into Instagram captions yet. That is a planner copy change (not built).

Turn it on (after the dev-api deploy; re-running keeps the other settings, and keeps `bio` if you omit it):
```
aws lambda invoke --function-name elettro-brand-os-dev-api --cli-binary-format raw-in-base64-out --profile stashbox-audit --region us-east-1   --payload '{"action":"setup-link-tracking-20261107","brandSlug":"stashbox","host":"go.stashbox.ai","bio":{"enabled":true,"title":"Stashbox","tagline":"Live band, music and merch","buttons":[{"key":"shop","label":"Shop the Stashbox store","url":"https://stashbox.ai"}]}}' out.json && cat out.json
```
(dry run first, then add `"mode":"apply"`). Smoke: `curl -s https://go.stashbox.ai/bio` shows the page; tap a tile on a phone and check
`{action:"events", code}`. SolarMeister gets the same page once its host exists (add `bio: true` to its `LINK_HOSTS` entry).

## SolarMeister later

Add `"go.solarmeister-shop.de"` (or the chosen host) to `LINK_HOSTS` in `apps/web/lib/link-hosts.ts`, add that domain to
Amplify, run the setup action with `brandSlug:"solarmeister"`, copy the pixel with its `ENDPOINT` changed to the new host.
The pixel works for any Shopify store; nothing else changes.

## Status 2026-11-07

Steps 1-5 done (Amplify domain added with Manual configuration so DNS stays at Namecheap; root and www excluded). Pixel privacy: Permission **Required → Analytics only**, Data sale **does not qualify** (safer than "Not required": it respects opt-outs if a banner is ever added). Local Windows DNS may cache the old NXDOMAIN for a while (`ipconfig /flushdns`).

## Never verified (2026-11-07)

Still unverified: a real tracked post end to end, the
pixel inside Shopify's sandbox (field names follow Shopify's Web Pixels API docs), and whether Pinterest/GMB accept the
tagged links. Unit tests: `node --test tests/link-tracking.test.mjs`.
