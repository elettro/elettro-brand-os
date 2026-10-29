-- PDF documents: a 'document' asset kind (LinkedIn document posts take PDFs).
-- DEV is migrated by the IAM-only setup-document-asset-kind-20261029 Lambda action.
ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'document';
