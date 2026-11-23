BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE "Asset" IN SHARE ROW EXCLUSIVE MODE;
-- The live metadata setup already has this column. Fresh legacy schemas may not.
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The live DEV database may already have these objects from the Step 8 rollout.
-- Missing IDs on legacy rows are permitted. Populated IDs must be well formed
-- and agree when both Dropbox source columns are populated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"Asset"'::regclass
      AND conname = 'Asset_dropbox_identity_integrity_ck'
  ) THEN
    ALTER TABLE "Asset" ADD CONSTRAINT "Asset_dropbox_identity_integrity_ck"
    CHECK (
      "sourceType" <> 'dropbox' OR (
        ("sourceFileId" IS NULL OR "sourceFileId" ~ '^id:[A-Za-z0-9_-]{8,200}$')
        AND ("sourceExternalId" IS NULL OR "sourceExternalId" ~ '^id:[A-Za-z0-9_-]{8,200}$')
        AND ("sourceFileId" IS NULL OR "sourceExternalId" IS NULL OR "sourceFileId" = "sourceExternalId")
      )
    );
  END IF;
END $$;

ALTER TABLE "Asset" VALIDATE CONSTRAINT "Asset_dropbox_identity_integrity_ck";

CREATE UNIQUE INDEX IF NOT EXISTS "Asset_dropbox_global_canonical_id_uq"
  ON "Asset" ((COALESCE("sourceExternalId", "sourceFileId")))
  WHERE "sourceType" = 'dropbox';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indrelid = '"Asset"'::regclass
      AND indexrelid = to_regclass('"Asset_dropbox_global_canonical_id_uq"')
      AND indisunique AND indisvalid AND indisready AND indimmediate
  ) THEN
    RAISE EXCEPTION 'Dropbox identity index is missing or invalid';
  END IF;
END $$;

COMMIT;
