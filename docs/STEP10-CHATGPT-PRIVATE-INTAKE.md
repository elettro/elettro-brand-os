# Step 10 — ChatGPT private Elettro intake (DEV; read-first, controlled write)

**As of 2026-10-14:** OpenAI's packaged-plugin API successfully **created** one PRIVATE personal plugin:
`elettro-publishing-engine` version 0.1.0. URL: `https://chatgpt.com/plugins/plugins_6acfb6de40ec819192defc730193248e`.

**Connection status: not yet connected or installed.** Private plugin creation does not prove that ChatGPT accepts API-key authentication on this user's plan. **Do not claim ChatGPT has accessed Dropbox or uploaded anything.** The prior ChatGPT custom-MCP form with Cognito OAuth remained blocked because Cognito does not advertise PKCE S256 or public-client token auth in discovery. We have not removed OAuth or weakened any access checks.

## Intended owner workflow

1. Attach image/video in ChatGPT, say which brand and what it is.
2. ChatGPT observes whatever user-file content it can actually access (no unsupported automatic claims about video frames).
3. Call read-only `elettro_prepare_file_intake` with the ChatGPT-authorized file object and draft metadata. Tools declare `_meta["openai/fileParams"]=["file"]`, with `file.download_url`, `file.file_id` required and `file.mime_type`, `file.file_name` optional.
4. Elettro suggests an **existing**, **brand-scoped** Dropbox folder and metadata. If no suitable folder, ask for user selection; never silently create one.
5. Review and approve exact brand, filename, folder, title, topic, contentGroup, creativeFamily, creativeNotes, tags and priority. The preview signs a 15-minute plan bound to the provider's identity and file_id.
6. Call `elettro_save_chat_file_to_dropbox` **only after explicit confirmation** and with the original signed plan token and same file_id. Separate permission `assets:upload` is required.
7. Pilot download is restricted to approved HTTPS OpenAI file-hosts (no redirects) and a hard streaming cap of **20 MiB**. Images/videos only for pilot, audio upload and large videos require a separately tested resumable job.
8. Server calculates Dropbox **4 MiB block SHA256 content hash**, scans the selected brand inventory for a matching file, and reuses exact bytes regardless of filename. Nonmatching filename conflicts **never overwrite**. When new, direct Dropbox content upload uses `mode:add`, `autorename:false`, `strict_conflict:true`. S3 is never used.
9. Server invokes existing `complete-dropbox-upload` API, then the existing confirmed metadata update, and read-only global immutable Dropbox-ID identity verification. Partial errors return a clear existing Dropbox path/ID for reconciliation and explicitly say **do not reupload**. The default internal owner approval is Approved, publish destinations are empty. It does **not** schedule or publish content.
10. Validate with a small disposable real image under explicit owner approval, verify exact destination, metadata and duplicates. Only then broaden eligibility, large-file resumable uploads, and client-role support.

## Auth: separate ChatGPT private bearer (no impact on Claude)

- Existing working Claude Code and Claude.ai SSM clients remain read-only with their original 6 tools. They must not see the ChatGPT-specific upload and preview tools.
- MCP supports a distinct `chatgpt_private` client ID with its **own** bearer token hash, permitted all six brand roots. No token plaintext in AWS, ChatGPT messages, repo, Dropbox, or logs.
- New Windows helper: `scripts/step9-chatgpt-private-client.ps1`. Do not recreate or rotate `claude_code` or `claude_web` tokens.
- `-Action Create`: creates Windows DPAPI-encrypted key locally plus a **hash-only** third client grant with `assets:read,folders:read`.
- `-Action CopyAwsJson`: copies hash-only entire SSM config. Edit the **existing** `/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON` SecureString in **us-east-1**. Never create a second parameter.
- `-Action Test`: authenticates remote MCP `tools/list`. Expect **7 tools** (six old reads + ChatGPT file intake preview). Do not start file transfer.
- `-Action CopyToken`: copies raw private key to the clipboard; paste only in plugin's protected **API key** connection prompt (if offered). Clear clipboard after completion.
- After read-only live asset and file-preview acceptance, `-Action EnableWrites` updates **only** third client grant to `assets:read,folders:read,assets:write,folders:write,assets:upload`; use CopyAwsJson and edit existing SSM value again. This enables 11 owner tools, without granting generic arbitrary new registrations (`assets:register` remains excluded).
- If private-plugin API key sign-in is unavailable, **stop**, do not paste token into generic ChatGPT text; use properly built AWS-only OAuth authorization broker or another supported signed-in plugin flow. Do not remove authentication.

## Implementation summary

- `apps/web/lib/ai-mcp-intake.ts`: validated file descriptors, metadata drafts, approved existing folder and HMAC signed intake plan.
- `apps/web/lib/ai-mcp-upload.ts`: bounded file URL download, Dropbox content-hash scan/reuse, no-clobber upload, registry registration and metadata verification.
- `apps/web/lib/ai-mcp-tools.ts`: ChatGPT-specific `openai/fileParams` file tool descriptors and permissions.
- `apps/web/lib/ai-mcp-auth.ts`: distinct `assets:upload` permission.
- `apps/web/lib/ai-mcp-oauth.ts`: optional write access only on an explicitly signed token with `elettro-mcp/write`; Cognito OAuth still not proven compatible.
- `apps/web/app/api/mcp/route.ts`: authorization / action routing and audit.
- `tests/ai-mcp-tools.test.mjs`: file schema + read/write separation tests, no changed Claude tool manifest.
- **CI:** GitHub Actions run **38604745968** passed after fixes to PowerShell syntax. This is an automated build, **not** an external upload acceptance test.

## Outstanding before production-grade direct chat uploads

- Prove packaged plugin installation and secure API-key credential UI on user's ChatGPT account.
- Confirm exact host domains returned by ChatGPT for user-attached file `download_url`; update allowlist narrowly if necessary.
- Test network payload size / Lambda/Amplify timeouts and failure recovery. Large videos need async resumable worker; do not depend on a single 20 MiB request for the media factory.
- Confirm live `complete-dropbox-upload` contract matches the latest Lambda PATCH4 deployment. Checked-in Lambda index is not the live PATCH4 artifact; never redeploy an old Lambda ZIP or overwrite active Lambda handlers.
- Run canary disposable upload, duplicate reuse, metadata verification and rollback/reconciliation tests.
- Keep publishing, cross-brand moves/deletes, stock library edits, and AI-created public asset registration disabled.

Relevant official OpenAI docs: `https://developers.openai.com/plugins/reference` (fileParams) and `https://developers.openai.com/plugins/build/plugins` (private API-key MCP manifest).
