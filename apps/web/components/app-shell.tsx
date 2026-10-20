"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandSwitcher } from "@/components/brand-switcher";
import { ReconnectBanner } from "@/components/reconnect-banner";
import { brandConfigs } from "@/lib/brand-config";

// One frame for every logged-in page: header on top, grouped rail on the left.
// Items without an href are planned pages, shown greyed as "soon".
const NAV: Array<{ label: string; items: Array<{ label: string; href?: string }> }> = [
  { label: "Workspace", items: [
    { label: "Dashboard", href: "/" },
    { label: "Assets", href: "/assets" },
    { label: "Content Pool", href: "/content-pool" },
    { label: "Collections", href: "/collections" },
    { label: "Upload", href: "/epe-upload" }
  ] },
  { label: "Publishing", items: [
    { label: "Planner", href: "/planner" },
    { label: "Review", href: "/review" },
    { label: "Calendar" },
    { label: "Connections", href: "/connections" }
  ] },
  { label: "Intelligence", items: [
    { label: "AI Gateway", href: "/ai-gateway" },
    { label: "Analytics" }
  ] },
  { label: "Settings", items: [
    { label: "Brands" },
    { label: "Presets", href: "/presets" }
  ] }
];

// Pages that stand alone (sign-in errors) keep no frame.
const BARE = ["/auth"];

const BRANDS = [{ id: "all", name: "All brands", timezone: "" }, ...brandConfigs.map(({ id, name, timezone }) => ({ id, name, timezone }))];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  if (BARE.some((p) => pathname.startsWith(p))) return <>{children}</>;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="app">
      <header className="app-header">
        <Link className="brandmark" href="/">Elettro <span>OS</span></Link>
        <div className="app-header-tools">
          <BrandSwitcher brands={BRANDS} />
          <a className="app-live" href="https://elettro.com/dash/" target="_blank" rel="noreferrer">
            <i aria-hidden="true" /> Live status
          </a>
          <a className="app-logout" href="/api/auth/logout">Log out</a>
        </div>
      </header>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          {NAV.map((section) => (
            <div className="nav-section" key={section.label}>
              <div className="nav-label">{section.label}</div>
              {section.items.map((item) =>
                item.href ? (
                  <Link key={item.label} href={item.href} className={`nav-item${isActive(item.href) ? " active" : ""}`}>
                    {item.label}
                  </Link>
                ) : (
                  <span key={item.label} className="nav-item soon" aria-disabled="true">
                    {item.label} <small>soon</small>
                  </span>
                )
              )}
            </div>
          ))}
        </nav>
        <div className="app-content"><ReconnectBanner />{children}</div>
      </div>
    </div>
  );
}
