# Claude Code and Claude web: Push to EPE

This change adds image/video intake (up to 20 MiB), folder rename/move, and a guarded repair of the original title-test status. Dropbox remains the master storage. Upload does not publish or transfer to S3. Existing records retain workflow state; new Claude uploads are Raw and Approved.

## Deployment

1. Let the `develop` Amplify build finish. The new tools and upload page run there.
2. Download `scripts/deploy-claude-folder-ops.py` from the merged commit and upload it to AWS CloudShell. Run:

```bash
python3 deploy-claude-folder-ops.py --deploy --repair-test
```

The script exports the CURRENT live `elettro-brand-os-dev-api`, verifies its AWS code hash, saves a timestamped backup, changes only `index.mjs`, and adds `claude-folder-ops.mjs`. It verifies every other archive entry is identical. Deployment uses AWS RevisionId to reject concurrent changes. The repair runs through an IAM Lambda invocation, is not exposed through HTTP or MCP, and updates only `ingestStatus` for `01e25531-b43c-478f-93fa-9a9f65a2ee89`. It stops unless that Elettro asset still has no title, no tags, Approved status, and Raw/needs_metadata ingest status. Enrichment status is not guessed.

3. Download/upload `scripts/enable-claude-upload.py` and run:

```bash
python3 enable-claude-upload.py
```

Do not run this while the other setup window is writing the same SSM parameter. This reads the latest value and adds `assets:upload` to `claude_code` and `claude_web`, preserving token hashes, brands and ChatGPT settings. It also ensures their already-authorized metadata/folder write grants are present. The SSM preflight detects concurrent changes, but SSM provides no compare-and-swap operation.

4. Reconnect Claude web and restart/reconnect Claude Code. Each existing Claude connection with read, metadata write, folder write and upload grants should list 14 tools. Five new tools are Claude-only:

- `elettro_prepare_upload_page`
- `elettro_prepare_file_transfer`
- `elettro_complete_file_transfer`
- `elettro_rename_brand_folder`
- `elettro_move_brand_folder`

Existing ChatGPT file tools and OAuth settings are preserved. This change does not enable Claude `assets:register` or the older paused standalone registration tool. Transfer registration is authorized through `assets:upload`.

## Claude Code

Save `scripts/push-to-epe.py` locally. Claude can use this helper after the owner authorizes the exact file, folder and metadata. It reads the existing token from `EPE_MCP_TOKEN`, `.mcp.json`, or matching server entries in `~/.claude.json`, without printing it. It reads the actual local bytes, computes the Dropbox content hash, asks EPE for a transfer plan, sends bytes to the one-use Dropbox URL, then completes registration and metadata.

```bash
python3 push-to-epe.py --file IMAGE.png --brand elettro --folder /1---elettro-brand-os/elettro/recovery-test-20261014 --metadata metadata.json --confirmed
```

Metadata is optional. Supported fields are title, tags, topic, contentGroup, creativeFamily, creativeNotes, priority. One owner instruction to push the reviewed file is sufficient authorization for its transfer sequence.

The helper saves a `.epe-transfer.json` receipt before sending bytes. If a response is lost or registration is pending, retry completion first:

```bash
python3 push-to-epe.py --brand elettro --resume IMAGE.png.epe-transfer.json --confirmed
```

The receipt contains a signed completion capability that expires in 30 minutes; keep it private. It does not contain the Dropbox OAuth token or the temporary upload URL. Expired capabilities require a new preparation; the duplicate scan should find already-saved content.

## Claude web

Do not assume a remote MCP connector can read a chat attachment's bytes or resolve its internal attachment ID. If actual byte access and outbound upload are available in that Claude session, it may use the prepare/complete transfer tools. Otherwise ask it:

> Push this file to EPE for Elettro. Prepare the metadata and use the existing recovery-test-20261014 folder. Give me the private upload page for the file.

Claude calls `elettro_prepare_upload_page` with the reviewed filename, folder, metadata and `confirmed:true`. Open the returned link, select the real file (download a Claude-generated file first), and click Save file to EPE. The page calculates its hash, checks exact duplicates, sends bounded chunks to Dropbox through the server, then registers and verifies the asset. Its approved folder/filename/metadata cannot be replaced by page arguments. The signed capability is scoped to that plan, lasts 30 minutes and is kept in the URL fragment. Do not share it.

This is a working transfer path with a user file-selection step, not a claim that every Claude web session can send attachments automatically. No arbitrary URL fetch, invented attachment URL or model-generated hash is accepted.

## Folder rename/move

Use the new tools with the full source folder path and either the new name or an existing destination parent. `confirmed:true` is required. Rename and move stay inside the same brand, cannot move the brand root, cannot move into the source/its children, cannot overwrite, and disallow ownership transfers/shared-folder moves. Case-only renames are currently blocked.

The Lambda inventories the folder, identifies registered files by immutable Dropbox IDs (including records with stale paths), rejects cross-brand/conflicting/missing identity, moves the folder and updates stored source paths in one database transaction. It preserves IDs and workflow statuses. If a database update fails before commit, it attempts to restore the Dropbox folder. A failed compensation or ambiguous commit returns `reconciliationRequired:true`; do not repeat the move blindly.

## Acceptance checks

After deployment, use a disposable image and folder:

1. Claude Code transfer: one uploaded or reused Dropbox file, one registered asset ID, expected metadata, Raw/Approved on a new asset.
2. Repeat the same transfer: reuse the same Dropbox ID and EPE asset ID, no extra registration or file.
3. Claude web upload page: choose the file and verify the same results.
4. Rename the folder and move it under another disposable folder. Confirm folder/file IDs, asset ID and workflow statuses stay unchanged, stored paths reflect the current location, and `elettro_verify_brand_asset` succeeds.
5. Verify the original title-test asset is Raw again if the guarded repair succeeded.

Local validation covers scoped tool visibility, signed capabilities, byte mismatch rejection, duplicate reuse, strict upload commits, web capability binding, bounded chunks, folder identity/path updates, and failure compensation. Live deployment, browser uploads, permissions and end-to-end AWS/Dropbox behavior still require the checks above.
