# Elettro Brand OS — Phase II Backlog

## P2-001: Permanent, library-wide duplicate prevention
Status: Deferred, awaiting persistent backend implementation.

Current behavior: SHA-256 detects repeated file bytes inside the active intake and a best-effort same-browser post-save ledger persists across refreshes. This is NOT reliable protection against duplicates that already exist, other browsers/devices, Dropbox discovery, or concurrent uploads.

Required: persist content hashes per brand in the canonical asset database; backfill existing assets from S3/Dropbox, with appropriate Dropbox content-hash handling; preflight and atomically enforce uniqueness on backend completion/ingestion; preserve canonical file ID and metadata; return duplicate-of/skip counts; test concurrent uploads, renames/moves, repeat batches across sessions and origins. Do not block unique items in mixed batches.

Existing duplicate records: audit safely and review references before any deletion.

Acceptance criterion: Reimport the same bytes from any browser or Dropbox location without creating another asset for the brand, while distinct encodes/versions remain distinct.

## Next core task (Phase I)
Dropbox-aware Add Assets destination workflow: browse existing brand-root folders, create folder, suggest destinations without forcing uncertain recommendations, bulk apply to similar grouped files, route finalized uploads into Dropbox as master storage, and retain Dropbox file IDs on indexing. Verify current upload path uses temporary S3 and has not been switched to Dropbox.
