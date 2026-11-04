// Shared stock graphics (DEV, 2026-11-01, requested by the account owner).
// Images under /1---elettro-brand-os/creative-assets/stock-graphics are shared across brands, so they
// are indexed under the same non-brand "creative-assets" library owner as the shared audio.
// Stock videos: only the seasonal subtrees listed in LIBRARY_VIDEO_ROOTS are indexed (2026-11-04); the rest of
// stock-videos stays unindexed. IAM-invoke only; dry run unless mode:"apply".
//   action "setup-shared-stock-graphics-20261101": registers the stock-graphics storage root.
//   action "tag-shared-stock-graphics-20261101":   sets title/topic/tags on already-indexed stock
//                                                  graphics, matched on Dropbox path (items[]).

import { LIBRARY_SLUG } from "./shared-audio-library.mjs";

export const LIBRARY_GRAPHICS_ROOT = "/1---elettro-brand-os/creative-assets/stock-graphics";
// Seasonal + solar stock videos only. Do NOT register the whole stock-videos folder: it also holds personal clips.
export const LIBRARY_VIDEO_ROOTS = [
  "/1---elettro-brand-os/creative-assets/stock-videos/christmas",
  "/1---elettro-brand-os/creative-assets/stock-videos/new-years-2027",
  // Mainly for SolarMeister and Neckermann Strom, but open to every brand (no allowedBrandSlugs limit).
  "/1---elettro-brand-os/creative-assets/stock-videos/solar-panels"
];
export const LIBRARY_STOCK_ROOTS = [LIBRARY_GRAPHICS_ROOT, ...LIBRARY_VIDEO_ROOTS];

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
    const roots = [];
    for (const rootPath of LIBRARY_STOCK_ROOTS) {
      const root = (await client.query('SELECT "id","brandId" FROM "BrandStorageRoot" WHERE "storageConnectionId"=$1 AND "rootPathLower"=$2', [conn.id, rootPath.toLowerCase()])).rows[0];
      if (root && root.brandId !== library.id) throw new Error(`Stock root ${rootPath} is registered to another owner`);
      roots.push({rootPath, registered: Boolean(root)});
    }
    const before = {libraryId: library.id, roots};
    if (mode !== "apply") return json(200, {ok: true, mode, note: "Dry run; nothing changed", before});
    for (const r of roots) if (!r.registered) await client.query(
      `INSERT INTO "BrandStorageRoot" ("brandId","storageConnectionId","rootPath","rootPathLower","updatedAt")
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`, [library.id, conn.id, r.rootPath, r.rootPath.toLowerCase()]);
    return json(200, {ok: true, mode, before, roots: LIBRARY_STOCK_ROOTS});
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
      if (!LIBRARY_STOCK_ROOTS.some((r) => lower.startsWith(r.toLowerCase() + "/")) || !tags.length) { results.push({path: item?.path, status: "rejected"}); continue; }
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
