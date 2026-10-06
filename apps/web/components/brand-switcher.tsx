"use client";

import { useState } from "react";

export type BrandOption = {
  id: string;
  name: string;
  timezone: string;
};

export function BrandSwitcher({
  brands
}: {
  brands: BrandOption[];
}) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");

  return (
    <select
      className="brand-select"
      aria-label="Select brand"
      value={brandId}
      onChange={(event) => setBrandId(event.target.value)}
    >
      {brands.map((brand) => (
        <option key={brand.id} value={brand.id}>
          {brand.name}
        </option>
      ))}
    </select>
  );
}
