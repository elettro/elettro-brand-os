# EPE metadata status and visual enrichment rollout

Scope: `develop` branch code review first. No direct AWS production change.

## 1. Workflow-state bug

Assistant metadata writes use `preserveWorkflowState:true` and the API returns success only after a second read confirms unchanged `ingestStatus`, `enrichmentStatus` and `approvalStatus`. If the deployed Lambda ignores this flag, the gateway reports an error after a detected change. It cannot silently repair a previously changed status.

The Dropbox sync refresh and folder-hint backfill paths no longer convert existing `raw` assets into `needs_metadata`. They preserve ingest state and update enrichment from `pending` to `suggested` only. New Dropbox-discovered assets still initially enter `needs_metadata`, consistent with the existing discovery policy. The dashboard's deliberate `markReady` transition remains unchanged.

**Deployment warning:** Current GitHub DEV API Lambda source is known to differ from the AWS deployed package. Do not replace the entire deployed Lambda ZIP using GitHub source. Reconcile the patched functions with the currently deployed ZIP first, verify Code SHA before update, preserve all existing Dropbox upload handlers, then test on a disposable Raw asset and a Ready asset.

## 2. Optional visual enrichment

New owner-authenticated `POST /api/assets/auto-enrich` analyzes missing metadata for one brand-owned Dropbox image or video. The web app calls it after successful dashboard registration when explicitly enabled. Claude Web/Code transfer paths also trigger optional analysis after identity verification.

- Image: Dropbox visual thumbnail. Video: a **single preview frame**, not video-wide or audio analysis.
- Model: Amazon Bedrock Converse API, configured with a vision-compatible model.
- Output: brief title, topic, creative family, description (creative notes), up to eight tags.
- Writes: only previously empty fields. Rechecks the asset after inference. Never moves files, overrides non-empty metadata, changes workflow state or publishes.
- Failures: registration remains successful; enrichment errors are counted separately.
- Idempotency: repeated calls skip completed metadata.
- Sources: brand root containment checked before retrieving a thumbnail. Bedrock receives image preview, brand, filename and relative path. Other private Dropbox files are not sent.

### Configuration (DEV only)

1. Select and authorize a vision-capable Bedrock model in `us-east-1`. Give the Amplify server runtime `bedrock:InvokeModel` permission for the approved model/inference profile. Confirm region compatibility and cloud usage cost.
2. Add these environment variables to the Amplify `develop` branch, then redeploy the branch:
   - `EPE_BEDROCK_VISION_MODEL_ID=<approved model ID>`
   - `EPE_AUTO_ENRICH_ENABLED=true`
   - `NEXT_PUBLIC_EPE_AUTO_ENRICH_ENABLED=true`
3. Without all three settings and AWS IAM access, the feature is **not operational**. It stays off by default.
4. Test a disposable Stashbox image uploaded as Raw, with empty title/tags. Confirm missing fields are filled and ingest, enrichment and approval remain exactly unchanged.
5. Test a Ready/Approved image, a video, an already titled asset, a source outside its brand root and a preview failure. Confirm no overwrite and that upload status remains successful.
6. Test existing Claude Web and Claude Code metadata writes separately. Both use the shared gateway, but their upload implementations have their own workflows.

### Current limits

This DEV increment enriches dashboard registrations and Claude Web/Code transfer completions, when enabled. Claude clients already send metadata in their own tool calls, so only remaining gaps are filled. Dropbox-only discoveries still need queue/scheduler integration before all intake paths are fully automated. AI video analysis currently sees one thumbnail and cannot describe motion or audio.

Do not label either feature live-verified until the deployment, AWS model authorization and end-to-end acceptance tests pass.
