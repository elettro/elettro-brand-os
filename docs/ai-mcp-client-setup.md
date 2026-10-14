# Elettro AI Gateway: AI Client Setup (development)

> **October 13 Step 9 update:** Begin with the **read-only, separately scoped** Claude Code and Claude.ai credentials in [Step 9 setup instructions](./STEP9-READONLY-MCP-CONNECTIONS.md). The broader write-enabled client example later in this document is **not approved for initial provisioning**. ChatGPT's credential and OAuth setup remain separate. No external MCP clients have been verified connected yet.

## Purpose and rollout status

One operational contract for **ChatGPT, Claude and the dashboard**. Each AI client runs the same brand-scoped MCP tools implemented by Elettro, backed by one Dropbox filesystem and one asset registry.

- Server implementation: `apps/web/app/api/mcp/route.ts`.
- Provider-neutral executor: `apps/web/lib/ai-gateway.ts`.
- Tool manifest: `apps/web/lib/ai-mcp-tools.ts`.
- Credential validator: `apps/web/lib/ai-mcp-auth.ts`.
- MCP endpoint: `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`.

**State:** Code exists on `develop`. Not authenticated/configured with ChatGPT or Claude yet, and deployment/runtime acceptance checks have not been completed. **Shared Stock Gallery features are paused.** The MCP manifest is brand-only. The dashboard continues unchanged.

## Authentication for development

The MCP endpoint does not accept a dashboard browser cookie. It requires a per-assistant bearer token whose SHA-256 hash is stored server-side. No real token is checked into GitHub. The endpoint fails closed until credentials are provisioned.

Store an AWS Systems Manager **SecureString** parameter named:

`/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON`

An environment variable `ELETTRO_AI_MCP_CLIENTS_JSON` is also supported. Store only token hashes, not plaintext tokens:

```json
{
  "clients": [
    {
      "id": "claude_code",
      "tokenSha256": "REPLACE_WITH_FIRST_64_HEX_SHA256",
      "brandSlugs": ["stashbox", "elettro"],
      "permissions": ["assets:read", "folders:read"],
      "enabled": true
    },
    {
      "id": "claude_web",
      "tokenSha256": "REPLACE_WITH_SECOND_64_HEX_SHA256",
      "brandSlugs": ["stashbox", "elettro"],
      "permissions": ["assets:read", "folders:read"],
      "enabled": true
    }
  ]
}
```

For initial setup, use the [Windows DPAPI-protected Step 9 generator](../scripts/step9-readonly-clients.ps1), which creates a separate token for each Claude client and saves only token hashes in the SSM JSON. The one-off command below is a fallback for technical operators, not the recommended guided setup.

```bash
node -e 'const c=require("node:crypto");const token=c.randomBytes(32).toString("base64url"); console.log("SAVE TOKEN PRIVATELY:",token); console.log("STORE ONLY SHA256:",c.createHash("sha256").update(token).digest("hex"));'
```

Store the token itself only in the appropriate assistant's protected connector settings. When a client is revoked, disable or remove its entry and rotate its secret. AWS IAM must allow the Amplify server to read this specific parameter. Do not change the existing Cognito owner-session secret.

**Connector compatibility:** This bearer-token transport enables clients that support custom authorization headers (for example, a suitable MCP client configuration). Some ChatGPT connector flows require OAuth rather than manual bearer headers. Build and test a proper OAuth 2.1 / PKCE authorization integration before claiming ChatGPT is connected. Do not send private API credentials in chat messages.

## Supported operations

- `elettro_search_assets`: find assets in an authorized brand.
- `elettro_get_asset`: retrieve metadata for a single brand asset.
- `elettro_verify_brand_asset`: verify that a registered brand asset still points to its Dropbox file (read-only).
- `elettro_check_brand_file`: inspect whether a Dropbox file is already registered without writing or resetting status.
- `elettro_update_asset_metadata`: update existing asset tags, descriptions and metadata; requires explicit approval.
- `elettro_batch_update_metadata`: enrich up to 25 different existing brand assets with individual tags, titles and creative notes in one request; reports partial failures per asset. Requires confirmation.
- `elettro_register_brand_asset`: register an **already uploaded** Dropbox file as Raw; never publishes it.
- `elettro_list_brand_folders`: browse a brand's directory tree.
- `elettro_create_brand_folder`: create directories within a brand after explicit approval.

All of these can be used with equal scopes by both assistants; any difference comes from the provider's connector capabilities or available uploaded files.

**Not yet included:** moving registered files with database-path reconciliation; automatic file-byte upload through the MCP endpoint; shared Stock registration; public publishing tools; persistent per-operation database audit history.

ChatGPT already has an independently connected Dropbox workflow for uploading a conversation file. The AI Gateway can then register that Dropbox file; the two connections are not yet fully coordinated. Metadata enrichment can be done individually or in batches after the files are registered.

## Protocol smoke test

Once a distinct provider token is provisioned:

```bash
curl -i "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp" \
  -H "Authorization: Bearer YOUR_PRIVATE_PROVIDER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verification","version":"1"}}}'
```

Then test the read-only tools:

```bash
curl -i "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp" \
  -H "Authorization: Bearer YOUR_PRIVATE_PROVIDER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Do not place real credentials in command histories, pastebins, tickets, or screenshots.

## Acceptance checklist

1. CI builds web app and passes provider-parity tests on `develop`.
2. MCP requests without credentials fail; wrong token or other brand fails.
3. ChatGPT and Claude credentials reveal identical tools when assigned identical grants.
4. Read-only clients cannot use write actions; stock paths cannot be used through the brand-only tools.
5. Existing asset search, read and metadata editing match the dashboard and respect its brand scope.
6. Register a test Dropbox image in **raw** mode, repeat registration and verify idempotency, confirm not in publishable pool.
7. Verify no changes to Stashbox/Elettro folders from connector setup.
8. Add OAuth connector compatibility and independently connect/test **both** clients before marking live.

## Future phases

- Shared asset move + registry path reconciliation by immutable Dropbox ID, with rollback strategy.
- Direct assistant file upload and post-upload registration; reuse the successful dashboard preflight/dedupe approach.
- Durable audit records identifying assistant/client ID, brand, asset, operation, time, before and after values.
- OAuth authorization, consent and role controls.
- After ordinary brand content is operational, resume shared Stock Gallery intelligence (currently paused).

### Registration protection

The gateway now performs an identity preflight by Dropbox file ID/path. Exact existing registrations are reused without another Raw ingestion call, preserving their current Ready/Approved status. Ambiguous same-name matches fail closed for review. These behaviors have code coverage, but a real second-registration test with a disposable brand file is still pending. Step 5 of the AI Gateway Lab is read-only and safe to run first.
