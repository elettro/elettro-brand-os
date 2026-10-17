-- SUPERSEDED — DO NOT RUN.
-- The /brands/ trees are Dropbox copies with new file IDs. Updating BrandStorageRoot
-- paths alone would orphan registered assets and let the next sync insert duplicates.
-- Use the ID-aware, transactional `migrate-dropbox-brand-roots-20261017` action in
-- services/dev-api-lambda/brand-root-migration.mjs (see docs/DROPBOX-BRAND-ROOT-MIGRATION-20261017.md).
DO $$ BEGIN RAISE EXCEPTION 'Superseded: use the migrate-dropbox-brand-roots-20261017 Lambda action'; END $$;
