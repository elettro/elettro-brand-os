"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandSwitcher } from "@/components/brand-switcher";
import { NavLink } from "@/components/nav-link";
import { ReconnectBanner } from "@/components/reconnect-banner";
import { brandConfigs } from "@/lib/brand-config";

// One frame for every logged-in page: header on top, grouped rail on the left.
// Items without an href are planned pages, shown greyed as "soon".
type NavSection = { label: string; collapsible?: boolean; items: Array<{ label: string; href?: string }> };
const NAV: NavSection[] = [
  { label: "Workspace", items: [
    { label: "Dashboard", href: "/" },
    { label: "Assets", href: "/assets" },
    { label: "Content Pool", href: "/content-pool" },
    { label: "Collections", href: "/collections" },
    { label: "Upload", href: "/epe-upload" }
  ] },
  { label: "Publishing", items: [
    { label: "Review", href: "/review" },
    { label: "Calendar", href: "/calendar" },
    { label: "Connections", href: "/connections" }
  ] },
  // A clickable dropdown, so the rail does not always list every holiday (owner only for now).
  { label: "Holidays", collapsible: true, items: [
    { label: "Halloween · Oct 31", href: "/holidays/halloween" }
  ] },
  { label: "Intelligence", items: [
    { label: "Analytics" }
  ] },
  { label: "Settings", items: [
    { label: "Brands" },
    { label: "Presets", href: "/presets" }
  ] },
  // Super admin only (owner): hidden from every client in CLIENT_NAV, and the page and its API are owner-only on the server.
  { label: "Admin", items: [
    { label: "AI Gateway", href: "/ai-gateway" },
    { label: "Planner", href: "/planner" }
  ] }
];

// The AR section: shown to the owner always, and to a client only when one of their brands has AR on.
const AR_SECTION: NavSection = { label: "AR", items: [
  { label: "Experiences", href: "/ar" },
  { label: "Actions" },
  { label: "Scan sets", href: "/ar/sets" },
  { label: "QR codes", href: "/ar/qr" },
  { label: "Settings" }
] };

// Pages that stand alone (sign-in errors) keep no frame.
const BARE = ["/auth", "/welcome"];

const BRANDS = [{ id: "all", name: "All brands", timezone: "" }, ...brandConfigs.map(({ id, name, timezone }) => ({ id, name, timezone }))];

// What a user who is not the owner (a client) sees in the rail. Pages not listed show greyed as "soon";
// each follow-up that opens a page for clients flips it to "active" here.
const CLIENT_NAV: Record<string, "active" | "soon" | "hidden"> = {
  "/": "active", "/ar": "active", "/ar/qr": "active", "/ar/sets": "active", "/review": "active", "/calendar": "active", "/assets": "active", "/content-pool": "active", "/connections": "active",
  "/collections": "hidden", "/holidays/halloween": "hidden", "/ai-gateway": "hidden", "/planner": "hidden"
};

// Who is signed in: owner sees everything; a client sees only the listed brands.
type Scope = { owner: boolean; brands: string[] | null };

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [scope, setScope] = useState<Scope | null>(null);
  const [showAr, setShowAr] = useState(false);
  const bare = BARE.some((p) => pathname.startsWith(p));
  useEffect(() => {
    if (bare) return;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ signedIn?: boolean; owner?: boolean; brands?: string[] | null }>)
      .then((s) => setScope(s.signedIn ? { owner: !!s.owner, brands: s.brands ?? null } : null))
      .catch(() => setScope(null));
  }, [bare]);
  useEffect(() => {
    if (bare || !scope) return;
    if (scope.owner) { setShowAr(true); return; }
    fetch("/api/ar/brands", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ brands?: string[] }>)
      .then((d) => setShowAr((d.brands?.length ?? 0) > 0))
      .catch(() => setShowAr(false));
  }, [bare, scope]);
  if (bare) return <>{children}</>;
  const client = !!scope && !scope.owner;
  const itemState = (item: { href?: string }) => (!client ? "active" : item.href ? CLIENT_NAV[item.href] ?? "soon" : "soon");
  const brands = scope?.brands ? BRANDS.filter((b) => scope.brands!.includes(b.id)) : BRANDS;
  const isActive = (href: string) => (href === "/" || href === "/ar" ? pathname === href : pathname.startsWith(href));

  return (
    <div className="app">
      <header className="app-header">
        <Link className="brandmark" href="/" aria-label="Elettro OS home"><img src="/brand/elettro-logo-white.png" alt="Elettro" width="407" height="161" /><span>OS</span></Link>
        <div className="app-header-tools">
          {scope && <Suspense fallback={null}><BrandSwitcher brands={brands} /></Suspense>}
          <a className="app-ar" href="https://elettro.com/ar/" target="_blank" rel="noreferrer">AR</a>
          <a className="app-live" href="https://elettro.com/dash/" target="_blank" rel="noreferrer">
            <i aria-hidden="true" /> Live status
          </a>
          <a className="app-logout" href="/api/auth/logout">Log out</a>
        </div>
      </header>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          {(showAr ? [...NAV.slice(0, 2), AR_SECTION, ...NAV.slice(2)] : NAV).filter((section) => section.items.some((item) => itemState(item) !== "hidden")).map((section) => (
            <div className="nav-section" key={section.label}>
              {section.collapsible ? null : <div className="nav-label">{section.label}</div>}
              {section.collapsible ? <details className="nav-drop" open={section.items.some((item) => item.href && isActive(item.href))}><summary className="nav-label">{section.label}</summary>{section.items.filter((item) => itemState(item) !== "hidden").map((item) => item.href ? (
                <Suspense key={item.label} fallback={<Link href={item.href} className={`nav-item${isActive(item.href) ? " active" : ""}`}>{item.label}</Link>}>
                  <NavLink href={item.href} className={`nav-item${isActive(item.href) ? " active" : ""}`}>{item.label}</NavLink>
                </Suspense>
              ) : null)}</details> : null}
              {!section.collapsible && section.items.filter((item) => itemState(item) !== "hidden").map((item) =>
                item.href && itemState(item) === "active" ? (
                  <Suspense key={item.label} fallback={<Link href={item.href} className={`nav-item${isActive(item.href) ? " active" : ""}`}>{item.label}</Link>}>
                    <NavLink href={item.href} className={`nav-item${isActive(item.href) ? " active" : ""}`}>
                      {item.label}
                    </NavLink>
                  </Suspense>
                ) : (
                  <span key={item.label} className="nav-item soon" aria-disabled="true">
                    {item.label} <small>soon</small>
                  </span>
                )
              )}
            </div>
          ))}
        </nav>
        <div className="app-content">{scope?.owner && <ReconnectBanner />}{children}</div>
      </div>
    </div>
  );
}
