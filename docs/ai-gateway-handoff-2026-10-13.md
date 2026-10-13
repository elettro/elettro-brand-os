# Elettro AI Gateway | Work Session Handoff | 2026-10-13

## Goal and boundaries

Create an **additional conversational intake route**, not a replacement for the existing dashboard. ChatGPT and Claude should operate **the same brand-content actions** through the same Elettro API and Dropbox-backed asset registry. Elettro is an ordinary brand, not an administrative override.

**Stock Gallery intelligence, generation, and publishing development is paused** while assets are being collected. Shared Stock folders remain untouched by this session.

## Changes committed to develop

| Feature | Files | Current state |
| --- | --- | --- |
| Provider-neutral AI Gateway | apps/web/lib/ai-gateway.ts | Initial V1 action executor already committed |
| Authenticated owner API | apps/web/app/api/ai-gateway/route.ts | Includes batch metadata entry point |
| Separate credentials for each assistant | apps/web/lib/ai-mcp-auth.ts | Hashed bearer token, independent brand and operation grants |
| Unified MCP tool catalog | apps/web/lib/ai-mcp-tools.ts | Both assistants see identical capabilities when assigned identical scopes |
| Remote MCP HTTP transport | apps/web/app/api/mcp/route.ts | Stateless JSON-RPC MCP initialization, tools/list, tools/call, audit logging |
| Individual asset metadata | Existing AI Gateway action | Title, topic, group, creative family, tags, creative notes, priority |
| Batch metadata enrichment | apps/web/lib/ai-gateway-batch.ts | Up to 25 **different** assets, results separately; no publication |
| Dropbox brand folder management | Existing gateway actions | Browse, create, brand boundaries |
| Register existing Dropbox brand file | Existing gateway action | Raw mode only, requires Dropbox file existence |
| Gateway diagnostics | apps/web/app/ai-gateway/page.tsx and client.tsx | Read-only owner page to verify capabilities, search, brand root listing |
| Dashboard navigation | apps/web/app/page.tsx | Added AI Gateway Lab link; dashboard preserved |
| CI and regression tests | .github/workflows/ci.yml; tests/ai-mcp-tools.test.mjs | Develop branch build triggered; static safety and assistant-parity tests |
| Live MCP smoke script | scripts/check-ai-mcp.mjs | Read-only init, tool listing, scoped folder and asset search checks |
| Setup guide | docs/ai-mcp-client-setup.md | Credential/protocol/acceptance instructions |

## Validated versus unverified

**Verified here:** Code commits exist in the develop GitHub branch. Five focused MCP manifest/permission tests were executed successfully in a local Node 22 sandbox using matching tool definitions. Further regression assertions are committed.

**Not verified:** A green complete GitHub CI run; successful AWS Amplify build and deployment; configured AWS SSM MCP credential parameter; live API responses; ChatGPT and Claude client connections; real registration and metadata updates through the new gateway.

The previous workflow used npm caching even though a package-lock file could not be found, so CI needs an explicit review if its run fails. Do not infer a green build from successful GitHub commits.

## Current supported action names (brand content)

- elettro_search_assets
- elettro_get_asset
- elettro_update_asset_metadata
- elettro_batch_update_metadata
- elettro_register_brand_asset
- elettro_list_brand_folders
- elettro_create_brand_folder

All mutations include an explicit confirmation field in the tool contract. The first version is owner-oriented and DEV-only.

## Deferred on purpose

- Dropbox file bytes uploaded *through* the MCP endpoint. ChatGPT's existing Dropbox integration can upload a conversation file independently; unified follow-on registration is not yet fully connected.
- Registered-file moves until Dropbox ID-based database path reconciliation is reliable and reversible.
- Cross-brand Stock source registration, stock generation and automatic stock publishing.
- OAuth/PKCE authentication for ChatGPT connector compatibility. The initial MCP route uses individual bearer-token hashes; token configuration alone does not guarantee client compatibility.
- Durable per-change database auditing; current MCP logs identify provider, brand, operation and success/failure in server logs.
- Publishing and approval changes through AI tools.

## Resume checklist

1. Check latest Amplify `develop` deployment / CI build and resolve TypeScript or workflow errors.
2. From logged-in develop dashboard, open **/ai-gateway**; click **Check API**, **Search brand assets**, and **Browse brand root**, trying Stashbox and Elettro.
3. Provision per-provider credential hashes in AWS Systems Manager according to `docs/ai-mcp-client-setup.md`, after appropriate user approval.
4. Run `scripts/check-ai-mcp.mjs` separately with authorized ChatGPT and Claude test credentials. Verify strict brand boundaries and tool parity.
5. Configure provider-specific OAuth/connector authentication as required and connect both AIs.
6. Test a small existing brand file: registration (Raw), metadata enrichment, duplicate registration and content-pool exclusion. Confirm results in the existing dashboard.
7. Test batch-enriching 3 files with different metadata, confirming all three records changed correctly.
8. Implement upload orchestration and registered-file move/reconcile as separate reviewed steps.

**Do not describe the connector as live until live steps 1–7 succeed.**

## Follow-up milestone: first live write verification (October 13)

- The owner-only AI Gateway Lab now has a **Step 4 · Metadata write and restoration test**.
- After deployment, select Stashbox, click **Search brand assets**, select one returned asset, then choose **Run write + restore test** and confirm.
- The server snapshots the original tags and ingest/approval status, writes a uniquely generated temporary tag, reads it back, removes only that tag, and reads the record again.
- A PASS means **writeVerified**, **cleanupVerified**, and **exactRestoration** are all true. If any check fails, inspect the returned JSON and do not run another test until the asset is reviewed.
- No stock-gallery files, Dropbox paths, publishing destinations, or approval statuses are intentionally changed.
- This controlled test is *not* exposed to ChatGPT or Claude MCP tools. It uses the signed-in owner dashboard only.
- Commits: `1acba84` (server helper), `987e768` (owner gateway route), `6b12f54` (test UI), `4260d1f` (regression assertions).
- **Do not claim the live metadata write has passed until the returned JSON verifies success and restoration.**

## October 13: live Step 4 result and Step 5 preparation

**Step 4 verified on live develop:** The user ran the metadata write + cleanup diagnostic on Stashbox asset `61e57e95-e8ec-4ddf-a986-824a4ccfddf9` (`dean-stashbox-does-dylan9x16-2.png`). The endpoint returned `writeVerified:true`, `cleanupVerified:true`, `exactRestoration:true`; tags were `[]` both before and after, and `ingestStatus:ready`, `approvalStatus:approved` were unchanged.

**Step 5 committed in develop, not yet live-verified:**
- Safeguarded `register_existing_asset` by looking up indexed records via Dropbox ID/path. Existing exact matches are reused without calling `complete-dropbox-upload` again. Uncertain same-name matches block registration rather than risk duplicating/resetting an existing asset.
- `inspect_registered_asset` is a read-only diagnostic checking the selected brand asset's Dropbox source file ID/path, or reporting that the registry lacks enough source information. It does not modify anything.
- `inspect_brand_registration` is a read-only Dropbox-path preflight to distinguish `registered`, `not_found`, and `needs_review`.
- Added Step 5 inspection controls to `/ai-gateway` and both assistants' MCP tool catalogs.
- **Do not claim idempotent re-registration end-to-end verified yet.** The initial Step 5 check reads only. Future testing of a genuinely new image registration in Raw mode and a second registration attempt requires a disposable brand test asset and explicit owner confirmation.

Step 5 operator instructions after successful Amplify deploy: select Stashbox, search for `dean-stashbox-does-dylan9x16-2.png`, scroll to Step 5 and click **Verify existing registration (read-only)**. A PASS requires `registrationVerified:true`. If the registry omits `sourceFileId` and `sourcePath`, the check will display `source_locator_unavailable`, which is a limitation to investigate, not evidence of a duplicate.

**Stock Galleries remain on hold.** The Step 5 work touches brand-owned files only and does not move, upload or change their approval status.

## Step 5 diagnostic: source_locator_unavailable (October 13)

User's live test on Stashbox asset `08adc79a-211e-4f9a-9ebe-da2614285dad` (`SE53F9~1.MP4`) returned `registrationVerified:false` with `verificationStatus:"source_locator_unavailable"`. Its `ingestStatus:ready` and `approvalStatus:approved` were unchanged.

Independent **read-only** Dropbox lookup confirms that the video exists at:
`/1---elettro-brand-os/stashbox/radio/1x1-promo-videos/1x1-surfing-dean-stashbox-radio/SE53F9~1.MP4`
with Dropbox file ID `id:UM9GhyUcVDgAAAAAAAMB-g`. Presence and basename alone DO NOT establish the database record's identity.

**Root-cause investigation:** The checked-in DEV API's asset detail query in `services/dev-api-lambda/db-main.mjs` returns `sourcePath` but not `sourceFileId`; the Prisma schema and Dropbox ingestion functions both use the stable `sourceFileId`. If `sourcePath` is null, the gateway currently cannot verify a source, even if the DB stores its Dropbox ID. Commit `905d42a` adds `a."sourceFileId"` to the detail query, with a regression assertion. The gateway's ID check was hardened to recognize moved files with the same Dropbox ID in commit `b38d901`.

**CRITICAL DEPLOYMENT SAFETY:** The `Build DEV API Lambda` GitHub Actions workflow only packages and uploads a ZIP **artifact**. It does **NOT** deploy the new Lambda to AWS. Moreover, the checked-in Lambda source lacks the active `complete-dropbox-upload` action that is known to function in the deployed DEV API, indicating possible source/package drift. **Do not deploy the entire checked-in ZIP over the running Lambda without reconciling against its current deployed source, or Dropbox registration may regress.** A controlled, non-destructive Lambda update/reconciliation is needed first. Amplify deployment of the frontend does not apply this Lambda fix.

Next test when the live Lambda's asset detail response includes a stable `sourceFileId`: In the AI Gateway Lab, search for `SE53F9~1.MP4`, select the corresponding asset, and click **Verify existing registration (read-only)**. PASS must require exact Dropbox file-ID equality and same-brand folder containment. If the database's sourceFileId is null, inspect the original registration path before considering any backfill. **Do not re-register, backfill, or alter Ready/Approved status without a separate guarded procedure and explicit approval.**
