# Elettro AI Gateway V1 (develop only)

## Purpose

One **provider-neutral** action layer that can eventually be accessed from the Elettro dashboard, ChatGPT, and Claude. The dashboard is **not** being replaced. Dropbox remains the master filesystem and Elettro remains the single metadata/publishing registry.

Initial gateway implementation:

- Server module: apps/web/lib/ai-gateway.ts
- Authenticated Next.js API: POST /api/ai-gateway
- Development branch: develop

**Current status:** This is a server-side first increment, **not a connected ChatGPT or Claude MCP tool**. The endpoint accepts only a valid Elettro Cognito owner session and same-origin browser requests. Do not describe the AI connectors as live until the external auth/MCP adapter is implemented and tested.

## Input contract

JSON object with an action field. All brand-scoped operations require one of the real brand slugs; elettro is an ordinary brand, not a super-admin bypass.

### Read-only operations

- capabilities: {"action":"capabilities"}
- search_assets: {"action":"search_assets","brandSlug":"stashbox","query":"rehearsal","limit":25}
- get_asset: {"action":"get_asset","brandSlug":"stashbox","assetId":"<uuid>"}
- list_folders (brand): {"action":"list_folders","scope":"brand","brandSlug":"elettro","path":"/1---elettro-brand-os/elettro"}
- list_folders (stock): {"action":"list_folders","scope":"stock","path":"/1---elettro-brand-os/creative-assets/stock-videos"}

### Mutating operations (explicit confirmation required)

- Update metadata on one verified brand-owned asset, without making it publish-ready:

    {"action":"update_asset_metadata","brandSlug":"stashbox","assetId":"<uuid>","metadata":{"title":"Rehearsal clip","creativeNotes":"Dylan tribute rehearsals, booking goal","tags":["Dylan","keyboards","rehearsal"]},"confirmed":true}

  Supported fields: title, topic, contentGroup, creativeFamily, creativeNotes, tags, priority. Unsupported fields are rejected, not silently discarded. Uses the existing assets/bulk-update contract.

- Register a previously uploaded Dropbox file in its own brand folder:

    {"action":"register_existing_asset","brandSlug":"elettro","path":"/1---elettro-brand-os/elettro/images/onesheets/example.png","metadata":{"title":"Example","tags":["one-sheet"]},"confirmed":true}

  Dropbox file existence is checked first; existing server-side registration is called in raw mode only with no publishing destinations. Repeated attempts rely on the existing Dropbox-ID idempotency logic. There is no file-byte transport in this action.

- Create a folder, scoped to one brand or shared stock root:

    {"action":"create_folder","scope":"stock","path":"/1---elettro-brand-os/creative-assets/stock-videos/9x16","name":"Miami","confirmed":true}

The server checks boundaries. A brand path outside that brand, or a stock path outside creative-assets, is rejected. Dropbox OAuth refresh secrets remain on the server.

## Deliberately excluded from V1

1. **Shared-stock asset registration.** A cross-brand source must not be inserted as a normal publishable asset owned by whichever brand happens to be selected. Add the shared source/usage-rights model and enforce the brand allowlist first.
2. **Moving already-registered files.** Moving in Dropbox without synchronizing Elettro's sourcePath would leave stale locations. Implement move+reconcile by immutable Dropbox ID as one reliable workflow first.
3. **ChatGPT/Claude connection.** Build an MCP-compatible tool adapter on top of the shared executor, secured with provider-compatible OAuth, short-lived scopes, and per-action consent. Never paste an owner session cookie or AWS Dropbox secret into either assistant.
4. **Unattended publishing.** Publishing and approval changes are intentionally not exposed in this increment.
5. **Persistent audit trail.** A future database audit table should record operator identity, provider, asset ID, action, before/after, and timestamp. The current route only logs non-read action names.

## Agent integration design

- **Gateway core:** executeAiGateway() contains action validation and implementation, independent of any AI provider.
- **Transport A:** authenticated Next.js owner session (implemented).
- **Transport B:** OAuth-protected MCP adapter for ChatGPT (not implemented).
- **Transport C:** the same MCP adapter for Claude (not implemented).
- **Future scopes:** read:assets, write:metadata, read:folders, write:folders, write:files, write:registration, write:publishing. Authorize scopes and brands at the server for each request.
- The asset registry should track Dropbox IDs and enforce source-versus-publishable roles. Both assistants and dashboard should use identical mutation contracts.

## Acceptance tests

From an authenticated session on the develop site, after deploy:

1. Call capabilities and verify all seven actions are listed.
2. list_folders for elettro must display only Elettro folder's children, never sibling brands.
3. list_folders for stock must remain confined to creative-assets.
4. Try a stock scope with a brand path and a brand scope with the global root; both must return HTTP 403.
5. Try create_folder without confirmed: true; must reject without writing.
6. Create a disposable stock category, verify it appears in Dropbox, then remove it through explicitly approved cleanup.
7. search_assets must filter results to the named brand.
8. Try updating an asset under the wrong brand; must return 404 without changing anything.
9. update_asset_metadata must reject unknown fields and lack of explicit confirmation.
10. Register a harmless existing test file in raw mode; verify it is not in the publishing-ready pool. Repeat registration and verify no duplicate.
11. Verify the dashboard upload workflow remains unaffected.

## Next implementation steps

1. Confirm the gateway deploy and run smoke tests on develop.
2. Add shared Stock source model / usage permissions and registration without publishability.
3. Add Dropbox-ID move reconciliation and persistent audit log.
4. Implement and connect OAuth/MCP transport so ChatGPT and Claude can use the SAME actions.
5. Test actual attachment uploads through both assistants end to end, then expand permissions.

**Security note:** The owner-session API is only for testing the shared action logic; it is not a substitute for scoped external-AI authentication.
