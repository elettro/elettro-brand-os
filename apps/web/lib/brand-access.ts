// Who may see which brand. Cognito owns the accounts: a user in the "owner" group (or the owner email) sees every
// brand; anyone else sees only the brands whose "brand-<id>" group they belong to. Kept free of Next.js imports so the
// plain Node tests can load it.

export const OWNER_GROUP = "owner";
export const BRAND_GROUP_PREFIX = "brand-";

export type Access = { owner: boolean; brands: string[] };

export function accessFromClaims(email: string, groups: unknown, ownerEmail: string, knownBrands: readonly string[]): Access {
  const names = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : [];
  const owner = (!!ownerEmail && email.toLowerCase() === ownerEmail.toLowerCase()) || names.includes(OWNER_GROUP);
  const brands = [...new Set(
    names.filter((g) => g.startsWith(BRAND_GROUP_PREFIX)).map((g) => g.slice(BRAND_GROUP_PREFIX.length)).filter((id) => knownBrands.includes(id))
  )];
  return { owner, brands };
}

// What the signed session cookie stores: "*" for the owner, else a comma-separated brand list.
export function encodeScope(access: Access): string {
  return access.owner ? "*" : access.brands.join(",");
}

// Sessions signed before brand access existed carry no scope; they keep working for the owner email only.
export function decodeScope(scope: string | undefined, email: string, ownerEmail: string): Access | null {
  if (scope === undefined) return ownerEmail && email.toLowerCase() === ownerEmail.toLowerCase() ? { owner: true, brands: [] } : null;
  if (scope === "*") return { owner: true, brands: [] };
  const brands = scope.split(",").filter(Boolean);
  return brands.length ? { owner: false, brands } : null;
}

export function canAccessBrand(access: Access | null, brand: string): boolean {
  return !!access && (access.owner || access.brands.includes(brand));
}

export function visibleBrands<T extends { id: string }>(access: Access | null, all: readonly T[]): T[] {
  return all.filter((b) => canAccessBrand(access, b.id));
}
