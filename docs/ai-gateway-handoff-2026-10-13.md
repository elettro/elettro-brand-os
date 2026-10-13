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
