-- Shared audio library: audio asset kind + which brands may use a shared asset.
-- DEV was migrated by the IAM-only setup-shared-audio-library-20261017 Lambda action.
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'audio';
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "allowedBrandSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
