// What a restricted (client) account may read through the web app's dev-api proxy, and which brand tags it may change.
// Pure functions with no Next.js imports so the plain Node tests can load them. The owner is never scoped.

export const SHARED_LIBRARY = "creative-assets";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
const SHARED_ROOTS = ["/1---elettro-brand-os/creative-assets/", BRANDS_ROOT + SHARED_LIBRARY + "/"];

export type ScopedRead = { ok: true; search: string } | { ok: false; status: number };

// Folders a thumbnail may come from: the user's own brand folders and the shared creative-assets library.
export function thumbnailPathAllowed(path: string, brands: readonly string[]): boolean {
  if (!path || path.includes("\0") || path.split("/").some((part) => part === "..")) return false;
  const lower = path.toLowerCase();
  const roots = [...brands.map((b) => BRANDS_ROOT + b + "/"), ...SHARED_ROOTS];
  return roots.some((root) => lower.startsWith(root));
}

// Rewrites a proxied read for a client: the brand list always comes from the session, never from the request.
export function scopeRead(route: string, search: string, brands: readonly string[]): ScopedRead {
  const params = new URLSearchParams(search);
  params.delete("brands");
  params.delete("shared");
  if (!brands.length) return { ok: false, status: 403 };

  if (route === "dropbox/thumbnail") {
    return thumbnailPathAllowed(params.get("path") || "", brands) ? { ok: true, search: params.toString() ? "?" + params.toString() : "" } : { ok: false, status: 403 };
  }
  if (route === "assets") {
    if (params.get("dropboxFileId")) return { ok: false, status: 403 };
    if (params.get("metadataOptions") === "1") {
      const slug = params.get("brandSlug") || "";
      if (!brands.includes(slug) && slug !== SHARED_LIBRARY) return { ok: false, status: 403 };
    } else {
      params.set("shared", "1");
    }
  }
  if (route === "assets" && params.get("metadataOptions") === "1") {
    return { ok: true, search: "?" + params.toString() };
  }
  params.set("brands", brands.join(","));
  return { ok: true, search: "?" + params.toString() };
}

// A client changes only their own brands on a shared asset's tags; every other brand's tag stays as it is.
export function mergeBrandTags(current: readonly string[], requested: readonly string[], userBrands: readonly string[]): string[] {
  const keep = current.filter((slug) => !userBrands.includes(slug));
  const add = requested.filter((slug) => userBrands.includes(slug));
  return [...new Set([...keep, ...add])];
}
