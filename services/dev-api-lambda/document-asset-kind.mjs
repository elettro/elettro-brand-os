// Adds the 'document' asset kind (PDF files) to the AssetKind enum (DEV, 2026-10-29).
// IAM-invoke only; dry run unless mode:"apply". Enum values cannot be dropped, so the dry run says what exists first.

export async function runDocumentAssetKindSetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const kinds = (await client.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='AssetKind'`)).rows.map(r => r.enumlabel);
    const before = {kinds, hasDocument: kinds.includes("document")};
    if (mode !== "apply") return json(200, {ok: true, mode, note: "Dry run; nothing changed", before});
    // ALTER TYPE ... ADD VALUE cannot share a transaction with statements that use the new value.
    if (!before.hasDocument) await client.query(`ALTER TYPE "AssetKind" ADD VALUE IF NOT EXISTS 'document'`);
    return json(200, {ok: true, mode, before, added: !before.hasDocument});
  } catch (error) {
    console.error("[document-asset-kind] failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "setup failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
