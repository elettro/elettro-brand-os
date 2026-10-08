# Shopify Asset Source

## Principle

Shopify media stays in Shopify.

Elettro Brand OS must **not** copy Shopify product media into Dropbox merely so the planner can use it.

## Source-of-truth model

- Dropbox is the source of truth for creator/production assets.
- Shopify is the source of truth for Shopify commerce/product media.
- Brand OS indexes both into a common asset catalog.
- The planner can choose assets from either source.
- Usage history and publishing metadata live in Brand OS.

## What Brand OS stores for Shopify assets

- Shopify store
- product ID
- media ID
- media URL/reference
- product title
- vendor/brand
- product type
- collections/tags
- media dimensions/type
- AI metadata
- eligibility
- allowed destinations
- usage history
- performance history

## What Brand OS does not do

- duplicate Shopify files into Dropbox by default
- make Dropbox a shadow copy of the Shopify media library
- treat Shopify paths like Dropbox folders

## UX

Under Assets:

- All Assets
- Dropbox
- Shopify
- Needs Metadata
- Collections
- Presets

The Shopify workspace should be browsable by:

- product
- Shopify collection
- media type
- brand/vendor
- status
- indexed / not indexed

The user can make a Shopify-hosted asset available to the Content Pool without physically moving it.

## Planner behavior

A planner slot may select a Shopify asset if:

1. the asset is indexed in Brand OS,
2. it is approved,
3. it is eligible,
4. its format satisfies the destination,
5. the Shopify source reference is still valid.

If Shopify media is removed or becomes inaccessible, Brand OS marks the asset source as missing/unavailable rather than falling back to a Dropbox copy.

## V1 connector behavior

The connector indexes and references Shopify media.

`copyToDropbox = false`

This is an architectural rule, not merely a UI preference.
