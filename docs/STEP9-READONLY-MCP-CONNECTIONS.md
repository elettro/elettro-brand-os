# Step 9 — Read-only Claude Code / Claude.ai / ChatGPT connectivity

**Current status:** MCP service exists on DEV. Provider credentials are **not yet provisioned**. No Claude client or ChatGPT connection has yet been proven live. The owner requested that both dedicated Claude credentials have read-only access to **all six** brands. The initial Stashbox/Elettro-only credential provisioning was a temporary least-privilege acceptance test, not a limit on the owner. This is still not Elettro login/password authentication; each Claude client has its own revocable service credential.

Endpoint: `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`

Read-only tools available to these initial clients:

1. `elettro_search_assets` (the existing asset-list API currently covers a maximum of 500 recent records; this is not yet exhaustive search)
2. `elettro_get_asset`
3. `elettro_verify_brand_asset` (Dropbox source identity)
4. `elettro_verify_global_dropbox_id` (full-table DB identity check)
5. `elettro_check_brand_file` (existing Dropbox registration status)
6. `elettro_list_brand_folders`

No metadata-write, create-folder, upload, publish, move, delete, or new-registration tool is included in these read-only credentials. The broader gateway implementation is unchanged. Production and Shared Stock Galleries remain untouched.

## 1. Generate per-client credentials on Windows

Obtain the `develop` file `scripts/step9-readonly-clients.ps1` from the private GitHub repository:

[Elettro Windows read-only setup script](https://github.com/elettro/elettro-brand-os/blob/develop/scripts/step9-readonly-clients.ps1)

In ordinary PowerShell (not Run as Administrator) from the directory where you saved the script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\step9-readonly-clients.ps1 -Action Create
```

The script generates **two unrelated 256-bit bearer credentials** locally, encrypts their local copies with Windows DPAPI, and writes a JSON file containing **hashes only**. The plaintext tokens are NOT printed or saved unencrypted. The JSON file is at:

```text
%LOCALAPPDATA%\ElettroMCP\aws-readonly-clients.json
```

Do not upload any local `.dpapi` credential file to GitHub, Dropbox or chat. The tokens are tied to the local Windows account; don't run PowerShell under a different user. If credentials are lost or compromised, regenerate and revoke them instead of sharing them.

## 2. Provision AWS SSM parameter (only hashes)

In AWS Console, Region **us-east-1** → **Systems Manager → Parameter Store** → Create parameter.

- Name: `/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON`
- Tier: Standard
- Type: **SecureString**
- KMS: default AWS managed SSM key (or an authorized existing key)
- Value: JSON containing two `clients` objects from the local hash-only file.
- Client IDs: `claude_code`, `claude_web`.
- Each owner-controlled Claude client should now allow all six: `stashbox`, `elettro`, `solarmeister`, `weightlossdavie`, `neckermann-strom`, and `therasbox`. Permissions remain strictly `assets:read` and `folders:read`.

To copy just the hash-only JSON into the clipboard:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\step9-readonly-clients.ps1 -Action CopyAwsJson
```

Then paste it into the **SecureString Value** field. Don't paste raw tokens into the Parameter Store or ChatGPT.

**IMPORTANT:** Check if the named parameter already exists first; don't overwrite a working configuration without reviewing/merging it. Ensure Amplify's DEV SSR execution role is allowed `ssm:GetParameter` and `kms:Decrypt` as applicable for that specific parameter. A 503 from MCP usually means missing parameters/IAM; a 401 means invalid/missing bearer credential.

### Promoting the *existing* two-brand owner credentials to all six brands

If you already completed the first successful two-brand smoke test, do **not** regenerate credentials, delete the SSM parameter, or call `-Action Create` again. Download the current version of `scripts/step9-readonly-clients.ps1` from `develop`, replacing the old downloaded .ps1 (keep the generated DPAPI credential files unchanged).

Run in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\step9-readonly-clients.ps1" -Action ExpandBrands
```

This saves a **hash-only** local backup and changes the `brandSlugs` arrays of the **existing** `claude_code` and `claude_web` clients to all six brands. It does not regenerate tokens, change token hashes, or modify AWS.

Then copy the local hash-only config to the clipboard:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\step9-readonly-clients.ps1" -Action CopyAwsJson
```

In AWS Systems Manager → Parameter Store (`us-east-1`), open the **existing** `/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON` **SecureString**, click **Edit**, replace the Value with the clipboard JSON, and **Save changes**. Do **not** create another parameter, reveal its Value in screenshots, or modify the role's IAM policy. The role already has narrowly scoped `ssm:GetParameter` via `ElettroDevMcpCredentialsRead`.

After saving, rerun the read-only `-Action TestClaudeCode` test below. It now checks that every grant in the AWS MCP tool manifest matches the local brand list; it searches all authorized brand catalogs without changing files and tests denial of a deliberately nonexistent `outside-elettro` brand. You should see `6 authorized brands` and `unknown brand denied`.

The developer-facing code and tests can safely know all six brand identifiers; **never** store the plaintext bearer credentials in source control, shared screenshots, or chat.

## 3. Read-only MCP acceptance test, before any Claude connection

After GitHub CI / Amplify `develop` deployment of the annotations and parameter provisioning:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\step9-readonly-clients.ps1 -Action TestClaudeCode
```

Expected output:
```text
PASS: Claude Code MCP, six read-only tools, 6 authorized brands, unknown brand denied.
```

This tests the HTTP MCP protocol, authenticated read-only tool manifest, search of an existing known Stashbox asset, and denial of the unauthorized `solarmeister` brand. **If the test fails, do not connect any client yet; provide the error text only, never a bearer token or full header.**

### Verify the independent Claude.ai token as well

Before configuring the browser connector, test its separate credential:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\\step9-readonly-clients.ps1 -Action TestClaudeWeb
```

Expected: `PASS: Claude.ai separate credential, six read-only tools, 6 authorized brands.`

## 4. Connect Claude Code

**Windows / Claude Code 2.1.299:** The old `step9-readonly-clients.ps1 -Action ConnectClaudeCode` CLI command has been shown to fail with `Invalid configuration: : Invalid input` due to Windows native `add-json` argument passing. Do not retry the broken action.

Instead download [the tested Windows Claude Code registration fix](../scripts/step9-fix-claude-code-windows.ps1) and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\step9-fix-claude-code-windows.ps1" -Action Install
```

This adds one `elettro-dev` user-scope MCP entry to `~/.claude.json` while taking a local backup of any existing configuration. It validates the local Windows DPAPI credential helper, does not print or store token plaintext, and refuses to replace a different pre-existing `elettro-dev` entry. Tested on a Windows runner with **Claude Code 2.1.299**, including CLI recognition and preservation of unrelated settings. The runner did **not** use real credentials or prove live remote connectivity; verify `/mcp` in your Claude Code session afterward.

The fix registers a **user-scoped Streamable HTTP MCP server** with a `headersHelper` command. On every connection, Claude Code launches that local helper, which decrypts the DPAPI-protected token and emits the Authorization header **without storing a raw bearer token in Claude's MCP configuration or the command history**.

Requires a current Claude Code release supporting `headersHelper`. The helper installs a stable copy of itself under `%LOCALAPPDATA%\\ElettroMCP\\step9-readonly-clients.ps1` during credential creation. Do not delete that local copy while Claude Code is connected.

In Claude Code run `/mcp` and confirm **elettro-dev Connected**. Then ask:

> Use Elettro to find the Stashbox asset SE53F9~1.MP4. Verify its global Dropbox identity. Do not modify any metadata or files.

Never paste `claude mcp get elettro-dev` output here; it may include private request headers. To revoke, remove/disable the corresponding SSM entry and remove the client with `claude mcp remove elettro-dev --scope user`.

Official CLI documentation: https://code.claude.com/docs/en/mcp

## 5. Connect Claude.ai in the browser

Claude.ai supports custom remote MCP connectors with OAuth **or fixed Request headers**. For a private test account go to **Customize → Connectors → Add → Add custom connector**, using:

- Display name: `Elettro DEV (read-only)`
- Remote MCP URL: `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`
- Authentication: fixed request header / No sign in (UI wording varies)
- Header name: `Authorization`
- Header value: `Bearer <separate CLAUDE_WEB token>`, securely copied below

Copy the **header value** without printing the token:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\step9-readonly-clients.ps1 -Action CopyClaudeWebHeader
```

Paste from clipboard into Claude.ai's protected **Request headers** value field. **Do not** paste that value into ChatGPT or an issue tracker. Once connected, enable the connector in a conversation and ask the same read-only Stashbox verification question. If the UI insists on OAuth, stop and return with a screenshot **without credentials**.

Official Claude documentation: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

## 6. ChatGPT: a separate authentication integration

The same Elettro gateway can serve ChatGPT, but **this custom private MCP endpoint currently supports fixed bearer headers, not ChatGPT's full OAuth 2.1 resource / authorization discovery flow**. It must not be published as no-auth. The current ChatGPT custom MCP configuration may require an OAuth identity provider and availability depends on account and workspace features; don't assume Plus/Pro has full write privileges.

Next: reuse an established OAuth 2.1 provider (for example, an appropriately configured AWS Cognito authorization server or Auth0), verify scopes/audience/PKCE and token renewal, and connect ChatGPT's custom MCP/Plugin flow only when the supported account UI and authorization requirements are confirmed. Never expose private Elettro content without auth as a workaround.

Official references:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

## Hard gates for any further rollout

- The owner-controlled SSM credentials expose **only read-only functions**, with brand grants listing **all six** brands.
- Don't share or screenshot raw tokens; don't put them in the repository or send them to this assistant.
- Verify the first local HTTP smoke test, then Claude Code, then Claude.ai browser.
- Test revocation: disable a client entry and verify its token stops working; restore after re-authenticated read-only tests if required.
- Audit consumer access before widening to all six brands or enabling writes.
- Keep AI registration paused pending direct-AI write-flow acceptance; the existence of the Step 8 database uniqueness constraint alone does not authorize write tools.
