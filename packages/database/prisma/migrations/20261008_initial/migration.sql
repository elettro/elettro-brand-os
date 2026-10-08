CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE "BrandRole" AS ENUM ('owner','admin','editor','approver','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetKind" AS ENUM ('video','image','carousel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AssetSourceType" AS ENUM ('dropbox','shopify','direct_upload');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "IngestStatus" AS ENUM ('raw','analyzing','needs_metadata','ready','failed','source_missing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EnrichmentStatus" AS ENUM ('pending','suggested','reviewed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('needs_review','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "EligibilityType" AS ENUM ('evergreen','annual','one_time');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SubjectType" AS ENUM ('person','group','product','topic','event','show','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Organization" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Brand" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
  "approvalPolicy" TEXT NOT NULL DEFAULT 'creator',
  "allowAutoVariants" BOOLEAN NOT NULL DEFAULT FALSE,
  "brandVoice" TEXT,
  "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Brand_organizationId_slug_key" UNIQUE ("organizationId","slug")
);

CREATE TABLE IF NOT EXISTS "User" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT,
  "authProviderId" TEXT UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "BrandMember" (
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "role" "BrandRole" NOT NULL,
  PRIMARY KEY ("brandId","userId")
);

CREATE TABLE IF NOT EXISTS "StorageConnection" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL DEFAULT 'dropbox',
  "accountRef" TEXT NOT NULL,
  "secretRef" TEXT NOT NULL,
  "syncCursor" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "BrandStorageRoot" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "storageConnectionId" UUID NOT NULL REFERENCES "StorageConnection"("id") ON DELETE CASCADE,
  "rootPath" TEXT NOT NULL,
  "rootPathLower" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandStorageRoot_storageConnectionId_rootPathLower_key" UNIQUE ("storageConnectionId","rootPathLower")
);

CREATE TABLE IF NOT EXISTS "ShopifyStore" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "shopDomain" TEXT NOT NULL,
  "displayName" TEXT,
  "secretRef" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopifyStore_brandId_shopDomain_key" UNIQUE ("brandId","shopDomain")
);

CREATE TABLE IF NOT EXISTS "ShopifyProduct" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopifyStoreId" UUID NOT NULL REFERENCES "ShopifyStore"("id") ON DELETE CASCADE,
  "externalProductId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "handle" TEXT,
  "vendor" TEXT,
  "productType" TEXT,
  "status" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "collectionRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "productUrl" TEXT,
  "rawMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopifyProduct_shopifyStoreId_externalProductId_key" UNIQUE ("shopifyStoreId","externalProductId")
);

CREATE TABLE IF NOT EXISTS "IntakeBatch" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "name" TEXT,
  "source" TEXT NOT NULL DEFAULT 'dropbox',
  "creatorNote" TEXT,
  "defaultMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Collection" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Collection_brandId_slug_key" UNIQUE ("brandId","slug")
);

CREATE TABLE IF NOT EXISTS "Campaign" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Campaign_brandId_slug_key" UNIQUE ("brandId","slug")
);

CREATE TABLE IF NOT EXISTS "Subject" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" "SubjectType" NOT NULL DEFAULT 'other',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Subject_brandId_slug_key" UNIQUE ("brandId","slug")
);

CREATE TABLE IF NOT EXISTS "MetadataPreset" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetadataPreset_brandId_name_key" UNIQUE ("brandId","name")
);

CREATE TABLE IF NOT EXISTS "Asset" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
  "storageRootId" UUID REFERENCES "BrandStorageRoot"("id"),
  "intakeBatchId" UUID REFERENCES "IntakeBatch"("id"),
  "collectionId" UUID REFERENCES "Collection"("id"),
  "campaignId" UUID REFERENCES "Campaign"("id"),
  "sourceType" "AssetSourceType" NOT NULL DEFAULT 'dropbox',
  "shopifyStoreId" UUID REFERENCES "ShopifyStore"("id"),
  "shopifyProductId" UUID REFERENCES "ShopifyProduct"("id"),
  "sourceExternalId" TEXT,
  "sourceFileId" TEXT,
  "sourceUrl" TEXT,
  "sourceMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "sourcePath" TEXT,
  "sourcePathLower" TEXT,
  "contentHash" TEXT,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT,
  "fileSizeBytes" BIGINT,
  "kind" "AssetKind" NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "aspectRatioLabel" TEXT,
  "aspectRatio" DECIMAL(8,5),
  "orientation" TEXT,
  "durationMs" INTEGER,
  "hasAudio" BOOLEAN,
  "ingestStatus" "IngestStatus" NOT NULL DEFAULT 'raw',
  "enrichmentStatus" "EnrichmentStatus" NOT NULL DEFAULT 'pending',
  "title" TEXT,
  "aiDescription" TEXT,
  "topic" TEXT,
  "contentGroup" TEXT,
  "creativeFamily" TEXT,
  "creatorNote" TEXT,
  "creativeNotes" TEXT,
  "folderSuggestions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "aiSuggestions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "eligibilityType" "EligibilityType" NOT NULL DEFAULT 'evergreen',
  "eligibleFrom" DATE,
  "eligibleUntil" DATE,
  "annualFromMmdd" INTEGER,
  "annualUntilMmdd" INTEGER,
  "containsSpecificPricing" BOOLEAN NOT NULL DEFAULT FALSE,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "allowedDestinations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "excludedDestinations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'approved',
  "producedAt" TIMESTAMP(3),
  "firstApprovedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "AssetSubject" (
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE CASCADE,
  "subjectId" UUID NOT NULL REFERENCES "Subject"("id") ON DELETE CASCADE,
  "confidence" DECIMAL(5,4),
  "source" TEXT NOT NULL DEFAULT 'human',
  PRIMARY KEY ("assetId","subjectId")
);

CREATE INDEX IF NOT EXISTS "BrandStorageRoot_brandId_idx" ON "BrandStorageRoot"("brandId");
CREATE INDEX IF NOT EXISTS "ShopifyProduct_shopifyStoreId_title_idx" ON "ShopifyProduct"("shopifyStoreId","title");
CREATE INDEX IF NOT EXISTS "Asset_brandId_approvalStatus_ingestStatus_idx" ON "Asset"("brandId","approvalStatus","ingestStatus");
CREATE INDEX IF NOT EXISTS "Asset_brandId_eligibilityType_idx" ON "Asset"("brandId","eligibilityType");
CREATE INDEX IF NOT EXISTS "Asset_brandId_collectionId_idx" ON "Asset"("brandId","collectionId");
CREATE INDEX IF NOT EXISTS "Asset_brandId_campaignId_idx" ON "Asset"("brandId","campaignId");
CREATE INDEX IF NOT EXISTS "Asset_sourcePathLower_idx" ON "Asset"("sourcePathLower");
CREATE INDEX IF NOT EXISTS "Asset_sourceType_sourceExternalId_idx" ON "Asset"("sourceType","sourceExternalId");
CREATE INDEX IF NOT EXISTS "Asset_shopifyStoreId_shopifyProductId_idx" ON "Asset"("shopifyStoreId","shopifyProductId");

INSERT INTO "Organization" ("name","slug","updatedAt")
VALUES ('Elettro','elettro',CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET "name"=EXCLUDED."name","updatedAt"=CURRENT_TIMESTAMP;

WITH org AS (SELECT "id" FROM "Organization" WHERE "slug"='elettro')
INSERT INTO "Brand" ("organizationId","name","slug","timezone","updatedAt")
SELECT org."id", v.name, v.slug, v.timezone, CURRENT_TIMESTAMP
FROM org
CROSS JOIN (VALUES
  ('SolarMeister','solarmeister','Europe/Berlin'),
  ('Stashbox','stashbox','America/New_York'),
  ('WeightLossDavie','weightlossdavie','America/New_York'),
  ('Neckermann Strom','neckermann-strom','Europe/Berlin'),
  ('Therasbox','therasbox','America/New_York'),
  ('Elettro','elettro','America/New_York')
) AS v(name,slug,timezone)
ON CONFLICT ("organizationId","slug")
DO UPDATE SET "name"=EXCLUDED."name","timezone"=EXCLUDED."timezone","updatedAt"=CURRENT_TIMESTAMP;
