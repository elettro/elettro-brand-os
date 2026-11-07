# EOS-BUG-0008 - Product carousels mixed other products' images

Status: Fixed
Severity: Medium
Area: Review/Planner
Environment: DEV
Date reported: 2026-11-07
Date fixed: 2026-11-07
Date verified:
Reported by: Dean (spotted while checking the first tracked-link post)

## Symptom

The Stashbox Bluesky carousel "Bauhaus Style Trains Scene Pint Glass #6 · Every Angle 2" (published 2026-11-07 18:23 UTC,
https://bsky.app/profile/stashbox.bsky.social/post/3mzqje4qc752n) showed four different products: the Bauhaus glass, a
West Palm Beach tee, a St. Pete pelican tee and a Tabletop Photography pint glass. Caption and link named only the Bauhaus glass.

## Reproduction

1. Plan a week with a carousel format for a brand whose merch sector holds several products.
2. Expected: each carousel shows one product (its "Every Angle" slide set).
3. Actual: the lead image plus the next-best images of the whole sector, from any product.

## Root cause

`planWeek` in `planner-v2.mjs` built a carousel as "winner + next-best images of the same sector" (the code comment said
"one pillar per carousel"). The sector is the pillar (merch), not the product, so products were mixed. The product's own
6-slide set (`merch/video/9x16/150-bauhaus-style-trains-scene-pint-glass-16/every-angle-slide-01..06-4x5.jpg`) was ignored.

## Fix

`carouselMates` (planner-v2): a carousel shows ONE product. Order of preference: the lead's own numbered slide set
(same folder, same name before `-slide-NN`, slide order, whole set up to the max), else other images of the same product
(`shopifyProductId` or `product:` tag), else, for a non-product lead only, other non-product images of the pillar. A
product never borrows another product's images; if the chosen lead can't reach the minimum on its own, the next-ranked
candidate that can becomes the lead, else the slot is a gap. Each result carries `carouselFill` (set/product/generic).
Already-scheduled carousels are repaired by the IAM-only action `refill-carousel-slides-20261107` (`carousel-refill.mjs`).

Follow-up (same day, SolarMeister replan): carousels could repeat one picture filed twice (`zahlen-film.jpg` x2),
and SolarMeister's `produkt-<handle>` + `product-link` tags were not seen as products. `uniquePictures` drops repeats
(same file name) in the planner and the refill; `productKeyOf` reads `produkt-` tags like `productUrlFromTags` does.

## Files changed

- `services/dev-api-lambda/planner-v2.mjs`, `services/dev-api-lambda/carousel-refill.mjs`, `services/dev-api-lambda/index.mjs`
- `tests/carousels.test.mjs`, zip lists, `CLAUDE.md`

## Verification

Unit tests only. Not yet checked: the refill run against DEV, and the next planned carousel in Review.

## Future repair

If a carousel looks mixed again, run `refill-carousel-slides-20261107` as a dry run for the brand and read `before`/`after`.
Slide sets must keep the `<name>-slide-NN` file naming inside one folder per product.
