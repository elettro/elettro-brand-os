"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type BrandOption = {
  id: string;
  name: string;
  timezone: string;
};

// Pages that always show one brand (no "all brands" view) and open on this one when ?brand= is absent.
const SINGLE_BRAND_PAGES = ["/review", "/planner", "/ar"];
const DEFAULT_SINGLE_BRAND = "stashbox";

// The header dropdown and each page's own brand row share one value: the ?brand= query.
export function BrandSwitcher({
  brands
}: {
  brands: BrandOption[];
}) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const params = useSearchParams();
  const singleBrand = SINGLE_BRAND_PAGES.some((p) => pathname.startsWith(p));
  const options = singleBrand ? brands.filter((b) => b.id !== "all") : brands;
  const requested = params.get("brand") ?? "";
  const fallback = singleBrand ? DEFAULT_SINGLE_BRAND : "all";
  const brandId = options.some((b) => b.id === requested) ? requested : options.some((b) => b.id === fallback) ? fallback : options[0]?.id ?? "";

  return (
    <select
      className="brand-select"
      aria-label="Select brand"
      value={brandId}
      onChange={(event) => {
        const next = new URLSearchParams(params.toString());
        if (event.target.value === "all") next.delete("brand");
        else next.set("brand", event.target.value);
        const query = next.toString();
        router.push(query ? `${pathname}?${query}` : pathname);
      }}
    >
      {options.map((brand) => (
        <option key={brand.id} value={brand.id}>
          {brand.name}
        </option>
      ))}
    </select>
  );
}
