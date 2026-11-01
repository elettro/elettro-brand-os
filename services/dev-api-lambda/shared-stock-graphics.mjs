// Shared stock graphics (DEV, 2026-11-01, requested by the account owner).
// Images under /1---elettro-brand-os/creative-assets/stock-graphics are shared across brands, so they
// are indexed under the same non-brand "creative-assets" library owner as the shared audio.
// Stock videos stay unindexed. IAM-invoke only; dry run unless mode:"apply".
//   action "setup-shared-stock-graphics-20261101": registers the stock-graphics storage root.
//   action "tag-shared-stock-graphics-20261101":   sets title/topic/tags on already-indexed stock
//                                                  graphics, matched on Dropbox path (items[]).

import { LIBRARY_SLUG } from "./shared-audio-library.mjs";

export const LIBRARY_GRAPHICS_ROOT = "/1---elettro-brand-os/creative-assets/stock-graphics";

export async function runSharedStockGraphicsSetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const org = (await client.query('SELECT "id" FROM "Organization" WHERE "slug"=$1', ["elettro"])).rows[0];
    if (!org) throw new Error("Elettro organization not found");
    const conn = (await client.query('SELECT "id" FROM "StorageConnection" WHERE "organizationId"=$1 AND "provider"=$2', [org.id, "dropbox"])).rows[0];
    if (!conn) throw new Error("Dropbox connection not registered");
    const library = (await client.query('SELECT "id" FROM "Brand" WHERE "organizationId"=$1 AND "slug"=$2', [org.id, LIBRARY_SLUG])).rows[0];
    if (!library) throw new Error("Shared library owner missing; run setup-shared-audio-library first");
    const root = (await client.query('SELECT "id","brandId" FROM "BrandStorageRoot" WHERE "storageConnectionId"=$1 AND "rootPathLower"=$2', [conn.id, LIBRARY_GRAPHICS_ROOT.toLowerCase()])).rows[0];
    const before = {libraryId: library.id, graphicsRoot: root || null};
    if (root && root.brandId !== library.id) throw new Error("Stock graphics root is registered to another owner");
    if (mode !== "apply") return json(200, {ok: true, mode, note: "Dry run; nothing changed", before});
    if (!root) await client.query(
      `INSERT INTO "BrandStorageRoot" ("brandId","storageConnectionId","rootPath","rootPathLower","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [library.id, conn.id, LIBRARY_GRAPHICS_ROOT, LIBRARY_GRAPHICS_ROOT.toLowerCase()]);
    return json(200, {ok: true, mode, before, graphicsRoot: LIBRARY_GRAPHICS_ROOT});
  } catch (error) {
    console.error("[shared-stock-graphics] setup failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "setup failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

export async function runSharedStockGraphicsTagging(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, {ok: false, error: "Direct IAM invocation required"});
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const items = Array.isArray(event.items) ? event.items : [];
  if (!items.length || items.length > 200) return json(400, {ok: false, error: "items must hold 1-200 entries"});
  let client;
  try {
    client = await connectDatabase();
    const library = (await client.query('SELECT "id" FROM "Brand" WHERE "slug"=$1', [LIBRARY_SLUG])).rows[0];
    if (!library) throw new Error("Shared library owner missing");
    const results = [];
    for (const item of items) {
      const lower = String(item?.path || "").toLowerCase();
      const tags = Array.isArray(item?.tags) ? item.tags.filter(t => typeof t === "string" && t.trim()).map(t => t.trim().slice(0, 100)).slice(0, 50) : [];
      if (!lower.startsWith(LIBRARY_GRAPHICS_ROOT.toLowerCase() + "/") || !tags.length) { results.push({path: item?.path, status: "rejected"}); continue; }
      const asset = (await client.query('SELECT "id" FROM "Asset" WHERE "brandId"=$1 AND "sourcePathLower"=$2', [library.id, lower])).rows[0];
      if (!asset) { results.push({path: item.path, status: "not-indexed"}); continue; }
      if (mode === "apply") await client.query(
        'UPDATE "Asset" SET "title"=$2,"topic"=$3,"tags"=$4,"creativeNotes"=$5,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [asset.id, String(item.title || "").slice(0, 200) || null, String(item.topic || "").slice(0, 200) || null, tags, String(item.notes || "").slice(0, 2000) || null]);
      results.push({path: item.path, status: mode === "apply" ? "tagged" : "would-tag"});
    }
    return json(200, {ok: true, mode, results});
  } catch (error) {
    console.error("[shared-stock-graphics] tagging failed", error);
    return json(500, {ok: false, error: error instanceof Error ? error.message : "tagging failed"});
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
