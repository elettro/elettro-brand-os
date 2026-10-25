"use client";

import { useRouter } from "next/navigation";

export function StatsBrandSelect({ brands, value, allowAll = true }: { brands: Array<{ slug: string; name: string }>; value: string; allowAll?: boolean }) {
  const router = useRouter();
  return (
    <select
      className="brand-select"
      aria-label="Show stats for"
      value={value}
      onChange={(event) => router.push(event.target.value === "all" ? "/" : `/?brand=${event.target.value}`)}
    >
      {allowAll && <option value="all">All brands</option>}
      {brands.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
    </select>
  );
}
