# EOS-BUG-0002 - No "Disconnect successful" confirmation next to the button

Status: Fixed
Severity: Low
Area: Connections
Environment: DEV
Date reported: 2026-10-29
Date fixed: 2026-10-29
Date verified:
Reported by: Dean

## Symptom

After disconnecting, the page reloaded and the card flipped to Connect, but nothing said it had worked next to the button. The
only message was a banner at the top of the page, far above the LinkedIn card.

## Reproduction

1. Disconnect any network on Connections. 2. Expected: a success notice next to the button, then Connect. 3. Actual: silent reload.

## Affected examples

Seen on LinkedIn; the Disconnect button is one shared component, so all seven networks (YouTube, Google Business, Facebook +
Instagram, Threads, TikTok, Pinterest, LinkedIn).

## Working comparison

The LinkedIn test post shows its result next to its form, with an anchor on its section.

## Root cause

`ConnectionDisconnect` navigated straight to the page after success. Only the LinkedIn section had an anchor id, so the other six
networks reloaded at the top of the page.

## Fix

The button shows "✓ Disconnect successful" for about 1.8 s, then reloads onto that network's section. Added anchor ids
`youtube`, `gmb`, `meta`, `threads`, `tiktok`, `pinterest`. A test checks every network's button maps to a destination and has an anchor.

## Files changed

- `apps/web/components/connection-disconnect.tsx`
- `apps/web/app/connections/page.tsx`
- `tests/connection-disconnect.test.mjs`

## Commits / PRs

PR #243 (web only; Amplify deploys on merge).

## Verification

Automated: `tests/connection-disconnect.test.mjs` 6/6. NOT verified: the notice on the live page; Dean has not confirmed it.

## Regression risk

Low. The reload still lands on `/connections?...&disconnected=...`, so the top banner and cache-clearing logic are unchanged.

## Related bugs

- EOS-BUG-0001

## Future repair procedure

Edit `ConnectionDisconnect`; keep section ids in `connections/page.tsx` equal to the `network` prop values.
