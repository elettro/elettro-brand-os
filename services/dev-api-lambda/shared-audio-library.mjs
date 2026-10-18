// Shared audio library setup (DEV, 2026-10-17, requested by the account owner).
// Music under /1---elettro-brand-os/creative-assets/audio is shared across brands, so it is
// registered as a non-brand "library" owner (Brand row with status 'library', excluded from
// every status='active' brand query) with its own storage root. Only the audio subtree is
// registered; stock videos/graphics stay unindexed. Adds the 'audio' asset kind and an
// allowedBrandSlugs column recording which brands may use a shared asset.
// IAM-invoke only; dry run unless mode:"apply".

export const LIBRARY_SLUG = "creative-assets";
export const LIBRARY_AUDIO_ROOT = "/1---elettro-brand-os/creative-assets/audio";

export async function runSharedAudioLibrarySetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const kinds = (await client.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='AssetKind'`)).rows.map(r => r.enumlabel);
    const hasColumn = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name='Asset' AND column_name='allowedBrandSlugs'`)).rowCount > 0;
    const org = (await client.query('SELECT "id" FROM "Organization" WHERE "slug"=$1', ["elettro"])).rows[0];
    if (!org) throw new Error("Elettro organization not found");
    const conn = (await client.query('SELECT "id" FROM "StorageConnection" WHERE "organizationId"=$1 AND "provider"=$2', [org.id, "dropbox"])).rows[0];
    if (!conn) throw new Error("Dropbox connection not registered");
    const library = (await client.query('SELECT "id","status" FROM "Brand" WHERE "organizationId"=$1 AND "slug"=$2', [org.id, LIBRARY_SLUG])).rows[0];
    const root = (await client.query('SELECT "id","brandId" FROM "BrandStorageRoot" WHERE "storageConnectionId"=$1 AND "rootPathLower"=$2', [conn.id, LIBRARY_AUDIO_ROOT.toLowerCase()])).rows[0];
    const before = {audioKind: kinds.includes("audio"), allowedBrandSlugsColumn: hasColumn, libraryOwner: library || null, audioRoot: root || null};
    if (mode !== "apply") return json(200, {ok: true, mode, note: "Dry run; nothing changed", before});

    // ALTER TYPE ... ADD VALUE cannot share a transaction with statements that use the new value.
    if (!kinds.includes("audio")) await client.query(`ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'audio'`);
    await client.query("BEGIN");
    await client.query(`ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "allowedBrandSlugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`);
    const libraryId = library?.id || (await client.query(
      `INSERT INTO "Brand" ("organizationId","name","slug","status","settings","updatedAt")
       VALUES ($1,'Creative Assets (shared library)',$2,'library','{"sharedLibrary":true}'::jsonb,CURRENT_TIMESTAMP) RETURNING "id"`,
      [org.id, LIBRARY_SLUG])).rows[0].id;
    if (root && root.brandId !== libraryId) throw new Error("Audio root is registered to another owner");
    if (!root) await client.query(
      `INSERT INTO "BrandStorageRoot" ("brandId","storageConnectionId","rootPath","rootPathLower","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [libraryId, conn.id, LIBRARY_AUDIO_ROOT, LIBRARY_AUDIO_ROOT.toLowerCase()]);
    await client.query("COMMIT");
    return json(200, {ok: true, mode, before, libraryId, audioRoot: LIBRARY_AUDIO_ROOT});
  } catch (error) {
    try { await client?.query("ROLLBACK"); } catch {}
    console.error("[shared-audio-library] failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "setup failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
