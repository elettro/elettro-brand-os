"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

// Pages that read ?brand=; the sidebar carries the chosen brand to them.
const BRAND_PAGES = ["/", "/review", "/calendar", "/holidays", "/holidays/halloween", "/planner", "/connections"];

export function NavLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  const brand = useSearchParams().get("brand");
  const to = brand && BRAND_PAGES.includes(href) ? `${href}?brand=${encodeURIComponent(brand)}` : href;
  return <Link href={to} className={className}>{children}</Link>;
}
