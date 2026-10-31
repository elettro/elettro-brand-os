# Google Business (GMB) planning

Added 2026-10-31 (Dean). Rules: `GMB_ASSET_SPEC.md` (Dropbox / Claude Skills MD). Code: `services/dev-api-lambda/gmb-planner.mjs`
(planning) and `services/gmb-lambda` (publishing).

## How a GMB post is made

1. **Review → Posts per day → Google Business**: set a number (0-7 a week, 1 a day at most) and Save. This writes a `CadenceRule`
   (`placement` `update`) on the brand's connected GMB profile.
2. **Review → Plan** a week. `startPlanning` (planner-review.mjs) also calls `planGmbWeek`: one Update post per chosen day, spread
   across the week, at a time between 10:00 and 16:30 on the brand's clock, any weekday. The posts are saved `planned` (to review).
   Re-planning replaces the week's still-`planned` GMB drafts; approved, sent, paused and removed posts keep their day.
3. **Approve** each draft on Review (or approve the week). The tick Lambda `elettro-brand-os-dev-gmb` then publishes approved posts.

Each draft has: a pillar (A shows for hire, B custom song libraries, C label streaming + ads, F fan/release), a caption from the
pillar's written variants, one button + link, and one photo.

## Where the wording and buttons come from

`GMB_DEFAULTS` in `gmb-planner.mjs` holds Stashbox (A, B, C, F) and Elettro (B, C). Override or add a brand with
`Brand.settings.gmb` = `{ languageCode, pillars: { A: { weight, cta: { actionType, url }, captions: [..] }, ... } }`; each pillar needs a weight,
a button and at least one caption. A brand with no setup is skipped ("this brand has no pillar wording yet"). Captions are checked with
the publisher's rules (no URL or domain, no phone number, no ALL CAPS word, at most 1,350 characters) and a bad one is never used.
Button rule: Shopify item = SHOP + the product link, anything else = LEARN_MORE + the brand site, shows for hire = BOOK +
`https://stashbox.com/booking`; Stashbox Radio = LEARN_MORE + `https://stashbox.com/radio` (or a song page).

## Photos

The planner picks only from the brand's `.../image/4x3/`, `.../image/3x2/` and `.../image/16x9/` folders (approved, not retired,
JPG or PNG, 10 KB-5 MB). A filename with a pillar letter, e.g. `stashbox_band_A_live-music-for-your-event_03_4x3.jpg`, is used only
for that pillar; a photo without a letter fits any pillar. The least recently used photo goes first, and none repeats within a week.
The Dropbox sync does not store pixel sizes or MIME types, so the planner trusts the folder; the publisher measures the real image
(JPEG/PNG header via a Dropbox temporary link) and blocks anything that is not really 4:3, 3:2 or 16:9 and at least 1200x800.

## Mix

Over the 30 days to the end of the week, business pillars (A, B, C) must stay over half and fan (F) under half; the planner picks the
pillar furthest below its weight and never one that would push F to half. The publisher re-checks this (`gmb-mix`).

## Not built / not verified

- Offers and Events are not planned (Offers parked, Events wait for a real dated show).
- Shopify (SHOP) posts and song-page posts need a product or song link supplied by the brand setup; none are built into the defaults.
- The planner has not been run against the live database (no local DB); the first Plan on Review is the first real run.
- The GMB Lambda and tick rule are made by `scripts/gmb-publisher-setup.sh` (root profile); check `aws lambda get-function` before assuming posts publish.
- Brand Settings has no Pillars screen yet; pillars live in code defaults and `Brand.settings.gmb`.
