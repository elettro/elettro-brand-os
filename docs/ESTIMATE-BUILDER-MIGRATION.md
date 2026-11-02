# Internal Estimate Builder transplant

Source: elettro/elettro/estimate/index.html, copied without changing the original site.
Destination: /admin/estimate-builder.

## Staging state
- Existing standalone HTML, service data, four-level social slider, presets, estimate summary and print/copy interactions preserved.
- Logo path updated to absolute Elettro website URL.
- Route is deny-by-default. Configure ESTIMATE_BUILDER_ADMIN_USER and ESTIMATE_BUILDER_ADMIN_PASSWORD to test in an isolated development environment.
- No secrets are stored in this repository. Never place credentials in client-side code.
- This migration branch is not deployed and does not update elettro.com/estimate.

## Required before production merge
1. Identify the actual live os.elettro.com application/deployment and sync with its current code; this repo appears to include an early Sprint 1 shell.
2. Replace the temporary Basic authentication with verified master-owner session authorization in the live server. Do not rely on hiding the menu or noindex.
3. Add an Admin Tools > Estimate Builder link to the live left sidebar, displayed only for the master-owner account.
4. Verify the standalone HTML features, CSS, image links, service choices, calculations and responsive layout.
5. Decide whether /estimate on the Elettro marketing site should redirect or be removed only after the internal version is confirmed live.
6. Keep sensitive client pricing and draft proposals server-side when editable/saved estimates are added.

## Route behavior
Without both server-side environment variables, returns 503.
With incorrect Basic credentials, returns 401.
With correct credentials, serves the transplanted HTML with no-store/noindex headers.
