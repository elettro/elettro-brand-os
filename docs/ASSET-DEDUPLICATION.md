# Asset deduplication policy

## User expectation
A user can repeatedly drop files into a brand intake. Known duplicate bytes never create a second asset record or overwrite the original. A batch with both duplicates and new items continues processing the new items.

## Identity
- Dropbox ID: stable identity across renames and moves; track asset record by this ID.
- SHA-256: local exact byte-identity preflight and intake request fingerprint.
- Dropbox content_hash: compute/compare according to Dropbox's block-hash specification when Dropbox file metadata is available. This is **not** interchangeable with SHA-256.
- No name/path-only rejection; matching filenames with different bytes might be genuine revisions.
- Deduplication scope should default to the owning brand. Cross-brand same bytes are legitimate independent brand usages and need not create extra stored bytes.
- A known exact duplicate gets an existing asset reference and location without changing approval, tags, history or folder destination.
- A modified export, cropped image, different resolution, or transcode gets its own record. Perceptual similarity flags are advisory only.
- For repeated concurrent uploads, server must enforce uniqueness transactionally on (brand_id, sha256), or an equivalent canonical blob/brand link design, to avoid races.
- Where a Dropbox-discovered asset lacks SHA-256, match Dropbox ID first, then Dropbox content_hash with confirmed hash semantics; optionally compute SHA-256 in a later enrichment job.
- For uploads intended for Dropbox, perform server deduplication check before committing a file and recheck transactionally at registration. Include an idempotency key per upload request. Do not rely on client-only checks.
- On Dropbox rename/move, refresh path using file ID; do not count a new upload or remove history.
- Deletions preserve audit/history but remove active-availability assumptions. A reimport after deletion needs explicit policy for restoring or replacing stale references.

## Current testable scope
The Add Assets prototype computes SHA-256 through the Web Crypto API and skips exact duplicates among files in the current staging session or one newly selected batch. It does not query existing Dropbox files or persisted server records yet. The dropzone does not upload until a real Dropbox uploader is connected.

## Test
1. Drop image A twice in the same batch: one staged row.
2. Drop A again: skipped.
3. Rename A locally and drop it: skipped, because contents are identical.
4. Edit a pixel in A and drop it: new item retained.
5. Drop A and a new image B: A skipped, B included.
6. Save/resume/refresh will require server-side persistence and are not yet supported by this prototype.
