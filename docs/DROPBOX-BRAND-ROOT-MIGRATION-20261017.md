# Dropbox brand-content migration — runbook (2026-10-17)

## Desired layout

- `/1---elettro-brand-os/brands/{brand}/`: brand media (six existing brands)
- `/1---elettro-brand-os/creative-assets/`: shared stock media, **unchanged**
- `/1---elettro-brand-os/intelligence/`: brand and platform editorial knowledge, **unchanged**

## Why this is a coordinated change

DEV web code (Amplify), DEV API Lambda (`elettro-brand-os-dev-api`), Dropbox sync Lambda, and RDS `BrandStorageRoot` rows may deploy independently. The existing connector uses runtime Lambda code, NOT the GitHub branch. A GitHub workflow builds a ZIP artifact but **does not deploy the Lambda**. Moving Dropbox files alone will temporarily break listing, ingest, upload, and folder permissions until the API Lambda is deployed.

## Order of operations

1. Capture a baseline: six Dropbox folder IDs, child counts, EPE list_brand_folders results, sampled asset verification, DEV API Lambda version, active RDS roots and sync cursor state. Stop intake/sync while migrating.
2. Merge/deploy the app **and** manually deploy the DEV API Lambda package built from the same revision. Build step checks `index.mjs`, `db-main.mjs`, `dropbox-upload-session.mjs`, `dropbox-identity.mjs`, `claude-folder-ops.mjs`. Ensure the deployed Lambda reflects new `/brands/` paths, not just the source repository.
3. Move all six *existing* Dropbox folders (never duplicate/copy, preserving IDs) from `/1---elettro-brand-os/{brand}` to `/1---elettro-brand-os/brands/{brand}`. Leave `creative-assets` and `intelligence` unmoved.
4. Run `scripts/migrate-dropbox-brand-roots-20261017.sql` against the DEV RDS database. Transaction updates `BrandStorageRoot` in place, preserving IDs and `Asset.storageRootId`. It resets the Dropbox connection cursor for a full ID-based reconciliation; it does **not** rewrite unavailable asset paths speculatively. Execute through an authorized secure database connection.
5. Start a **fresh full Dropbox sync**, paginate to completion, then re-verify file IDs and source paths. Check upload/browser/registration and the MCP folder listing, plus direct-upload duplicate handling. Mark unavailable originals separately for review; do not assign source files by matching filenames alone.
6. Confirm no stale prefix remains for registered assets whose Dropbox IDs are live and within brand roots. Existing missing-ID records need human review, not silent substitution. Verify no new duplicates, statuses preserved, and brand separation.
7. Apply equivalent changes to production **only after DEV passes**, with separate backups/credentials. Do not move production social publishing without an explicit go-live check.

## Recovery

If the new Lambda is not deployed, or read/ingest fails: pause intake; move the six folders back to `/1---elettro-brand-os/{brand}` (same stable folder IDs); restore matching Lambda/web code and RDS `BrandStorageRoot` paths to old roots in one controlled rollback; reset sync cursor and revalidate. Avoid rewriting asset file IDs or restoring by filename.

## Historical source metadata

Prior ingestion left some source paths stale and some registered source IDs unavailable. A verified Dropbox ID is authoritative for relocation, not a filename search result. The migration must not turn those into phantom approved source files.

## Git branch

Changes are staged on `feature/dropbox-brands-root-migration-20261017` from `develop`. Merge/deploy requires coordinating the API Lambda and RDS steps above. Do not mistake a green Lambda *build* workflow for a successful AWS deployment.
