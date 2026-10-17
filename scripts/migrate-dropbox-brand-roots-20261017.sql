-- EPE Dropbox brand-root migration, 2026-10-17.
-- Run ONLY after reviewing the six Dropbox folder moves and deploying the new DEV API Lambda.
-- Run separately in each environment, using its own database. Never paste database credentials into code.
-- Stable Dropbox IDs and Asset.storageRootId are preserved. Assets are reconciled by full Dropbox sync.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BrandStorageRoot" r JOIN "Brand" b ON b."id"=r."brandId"
    WHERE b."slug" IN ('stashbox','elettro','solarmeister','neckermann-strom','weightlossdavie','therasbox')
      AND r."rootPathLower" NOT IN (
        lower('/1---elettro-brand-os/' || b."slug"),
        lower('/1---elettro-brand-os/brands/' || b."slug")
      )
  ) THEN
    RAISE EXCEPTION 'Unexpected brand storage root; abort migration and investigate';
  END IF;
  IF EXISTS (
    SELECT r."storageConnectionId",r."brandId"
    FROM "BrandStorageRoot" r JOIN "Brand" b ON b."id"=r."brandId"
    WHERE b."slug" IN ('stashbox','elettro','solarmeister','neckermann-strom','weightlossdavie','therasbox')
    GROUP BY r."storageConnectionId",r."brandId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple roots for same brand and connection; reconcile before migration';
  END IF;
END $$;

UPDATE "BrandStorageRoot" r
SET "rootPath"='/1---elettro-brand-os/brands/' || b."slug",
    "rootPathLower"=lower('/1---elettro-brand-os/brands/' || b."slug"),
    "updatedAt"=CURRENT_TIMESTAMP
FROM "Brand" b
WHERE r."brandId"=b."id"
  AND b."slug" IN ('stashbox','elettro','solarmeister','neckermann-strom','weightlossdavie','therasbox')
  AND r."rootPathLower"=lower('/1---elettro-brand-os/' || b."slug");

-- The Dropbox crawler starts at /1---elettro-brand-os. Reset cursors so a full
-- scan reconciles moved assets by immutable Dropbox ID instead of blindly replacing old path strings.
UPDATE "StorageConnection" sc
SET "syncCursor"=NULL,"updatedAt"=CURRENT_TIMESTAMP
WHERE sc."id" IN (
  SELECT DISTINCT r."storageConnectionId" FROM "BrandStorageRoot" r
  JOIN "Brand" b ON b."id"=r."brandId"
  WHERE b."slug" IN ('stashbox','elettro','solarmeister','neckermann-strom','weightlossdavie','therasbox')
);

COMMIT;

-- Verify: SELECT b."slug",r."rootPath" FROM "BrandStorageRoot" r
-- JOIN "Brand" b ON b."id"=r."brandId" ORDER BY b."slug";
-- After the full sync, verify every existing Dropbox source ID by ID and flag stale/missing assets.
