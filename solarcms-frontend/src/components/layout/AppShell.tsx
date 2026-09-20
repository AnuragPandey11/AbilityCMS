/**
 * The application frame.
 *
 * Navigation is built from `/auth/me` → `dashboards[]` (A-3). A User with two
 * dashboards sees exactly two entries, and the routes for the rest do not
 * exist — not hidden, absent (§2, §3.4).
 *
 * ── The sidebar collapses below `lg` ────────────────────────────────────────
 * It used to be a fixed 224px column at every width, which on a 390px phone
 * left 166px for the page. A Single Line Diagram in 166px is not a diagram,
 * and the people most likely to open one on a phone are standing in the plant
 * looking for the box that has gone quiet. Below `lg` it becomes a slide-over
 * behind a menu button; from `lg` up nothing changes.
 *
 * ── The sidebar is exactly one viewport tall, and scrolls on its own ────────
 * It was a `lg:static` flex child, so it stretched to whatever the page beside
 * it happened to be: a Plant with forty Devices produced a 4000px ribbon of
 * sidebar, and reaching "Sign out" meant scrolling to the bottom of a Device
 * table to find it. Navigation does not belong to the length of the page it
 * navigates to. `lg:sticky lg:top-0 lg:h-screen` pins it to the viewport, and
 * the `nav` between the brand and the account block takes the overflow — so a
 * long menu scrolls inside the sidebar while the page scrolls independently.
 */

import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissions } from "@/auth/usePermission";
import { useDashboards, dashboardLabel } from "@/auth/useDashboard";
import { LiveIndicator } from "@/live/LiveIndicator";
import { Button } from "@/components/ui";
import { BrandMark } from "@/components/layout/BrandMark";
import { ThemeToggle } from "@/theme/ThemeToggle";

/**
 * Administration menu.
 *
 * Every entry is a **noun naming the thing it owns**, and each owns both
 * creating and editing it. The previous mix — "Clients", "Plants", "New Plant"
 * — made the right destination depend on whether the thing already existed,
 * which is not a distinction anyone holds in their head: people think "I need
 * to sort out that plant", not "I need the create screen".
 *
 * Two entries were also named after tables rather than tasks. "Plant
 * Hierarchy" and "Device Bindings" describe `parent_device_id` and
 * `device_tag_bindings`; "Wiring & Diagram" and "Tag Mapping" describe what
 * somebody is actually trying to do.
 */
const ADMIN_LINKS = [
  { to: "/admin/clients", label: "Clients", permission: "system.admin" },
  { to: "/admin/plant-setup", label: "Plants & Devices", permission: "plant.manage" },
  { to: "/admin/hierarchy", label: "Wiring & Diagram", permission: "plant.manage" },
  { to: "/admin/bindings", label: "Tag Mapping", permission: "config.modify" },
  { to: "/admin/alarm-rules", label: "Alarm Rules", permission: "config.modify" },
  { to: "/admin/users", label: "Users", permission: "user.manage" },
  { to: "/admin/system", label: "System", permission: "system.admin" },
] as const;

function navClass({ isActive }: { isActive: boolean }): string {
  // The active row carries a left rail as well as a tint, so it stays
  // identifiable when the tint is close to a status colour.
  return `relative block rounded-control px-3 py-2 text-sm font-medium transition ${
    isActive
      ? "bg-accent/10 text-accent before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-full before:bg-accent"
      : "text-ink-muted hover:bg-surface-raised hover:text-ink"
  }`;
}

export function AppShell(): JSX.Element {
  const { me, logout } = useAuth();
  const dashboards = useDashboards();
  const { has } = usePermissions();
  const adminLinks = ADMIN_LINKS.filter((link) => has(link.permission));
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Navigating closes it. A drawer left open over the page you just asked for
  // is the single most irritating thing a mobile menu can do.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-screen bg-surface text-ink">
      {/* The scrim. Present only while the drawer is, and only below `lg`. */}
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close the menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
        />
      ) : null}

      <aside
        className={`z-40 flex w-56 shrink-0 flex-col border-r border-line bg-surface-sunken transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          menuOpen
            ? "fixed inset-y-0 left-0 translate-x-0"
            : "fixed inset-y-0 left-0 -translate-x-full lg:flex"
        }`}
      >
        <div className="shrink-0 border-b border-line px-4 py-4">
          <BrandMark />
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <div className="px-1 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Monitoring
          </div>
          {dashboards.length === 0 ? (
            <p className="px-3 py-2 text-xs leading-snug text-ink-faint">
              No dashboards are assigned to this account. Dashboard access is granted
              explicitly by an administrator.
            </p>
          ) : (
            dashboards.map((code) => (
              <NavLink key={code} to={`/d/${code}`} className={navClass}>
                {dashboardLabel(code)}
              </NavLink>
            ))
          )}

          {adminLinks.length > 0 ? (
            <>
              <div className="px-1 pb-2 pt-5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Administration
              </div>
              {adminLinks.map((link) => (
                <NavLink key={link.to} to={link.to} className={navClass}>
                  {link.label}
                </NavLink>
              ))}
            </>
          ) : null}
        </nav>

        <div className="shrink-0 border-t border-line p-3">
          <div className="truncate text-xs text-ink">{me?.role ?? "—"}</div>
          <div
            className="truncate text-[11px] text-ink-faint"
            title={
              me?.client_id === null || me?.client_id === undefined
                ? "No active Client. A platform administrator is a member of none."
                : `Client #${me.client_id}`
            }
          >
            {/* A-1. The active Client is context, and switching resets
                everything. Named rather than numbered: "Client #2" tells
                someone their own company's row id and nothing else. */}
            {me?.client_name ?? me?.client_code ?? (
              me?.client_id != null ? `Client #${me.client_id}` : "no Client"
            )}
            {me?.platform_admin ? " · platform admin" : ""}
          </div>
          <Button className="mt-2 w-full" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface-raised px-4 py-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="rounded-control border border-line p-1.5 text-ink-muted hover:text-ink lg:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator />
            {/* Hidden on a phone: the count is context, and the header there
                has room for the live state and the theme toggle, not both. */}
            <span className="hidden text-xs text-ink-faint sm:inline">
              {me?.plants.length ?? 0} Plant(s) visible
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
