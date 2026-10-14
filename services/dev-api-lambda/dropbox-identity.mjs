/**
 * Global immutable Dropbox identity across both legacy and dashboard ID fields.
 * Used by both live DEV registration writers without changing publishing status.
 * Caller must not use this helper inside an existing transaction.
 */
export class DropboxIdentityConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "DropboxIdentityConflict";
    this.statusCode = 409;
  }
}

export function assertDropboxFileId(id) {
  if (typeof id !== "string" || !/^id:[A-Za-z0-9_-]{8,200}$/.test(id)) {
    throw new DropboxIdentityConflict("Valid immutable Dropbox file ID is required");
  }
  return id;
}

export async function lockDropboxIdentity(client, id) {
  assertDropboxFileId(id);
  // Advisory lock serializes upgraded writers for this ID until COMMIT/ROLLBACK.
  // The separately approved unique DB index will protect all writers.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [id]);
}

export async function findDropboxAsset(client, id, expectedBrandId) {
  assertDropboxFileId(id);
  if (!expectedBrandId) throw new DropboxIdentityConflict("Brand must be resolved before Dropbox lookup");
  const lookup = await client.query(`
    SELECT "id", "brandId", "filename", "ingestStatus", "approvalStatus",
           "retiredAt", "sourceFileId", "sourceExternalId"
    FROM "Asset"
    WHERE "sourceType" = 'dropbox'
      AND ("sourceFileId" = $1 OR "sourceExternalId" = $1)
    ORDER BY "createdAt" DESC, "id"
    LIMIT 2
    FOR UPDATE
  `, [id]);
  if (lookup.rows.length > 1) {
    throw new DropboxIdentityConflict("Duplicate Dropbox ID exists in multiple asset records; review required");
  }
  const asset = lookup.rows[0];
  if (!asset) return null;
  if ((asset.sourceFileId && asset.sourceFileId !== id) ||
      (asset.sourceExternalId && asset.sourceExternalId !== id)) {
    throw new DropboxIdentityConflict("Conflicting Dropbox IDs exist on the asset; review required");
  }
  if (asset.retiredAt !== null && asset.retiredAt !== undefined) {
    throw new DropboxIdentityConflict("Dropbox ID belongs to a retired asset; review required");
  }
  if (asset.brandId !== expectedBrandId) {
    throw new DropboxIdentityConflict("Dropbox ID belongs to another brand; registration blocked");
  }
  return asset;
}

export async function withDropboxIdentityTransaction(client, id, brandId, operation) {
  assertDropboxFileId(id);
  await client.query("BEGIN");
  try {
    await lockDropboxIdentity(client, id);
    const existing = await findDropboxAsset(client, id, brandId);
    const result = await operation(existing);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { console.error("[dropbox-identity] rollback failed", rollbackError); }
    throw error;
  }
}
