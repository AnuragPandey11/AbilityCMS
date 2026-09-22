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
 *
 * ── The open-Alarm count rides on the navigation ────────────────────────────
 * It is the one number that should reach somebody who is looking at a
 * different screen, because every other figure here describes a state they
 * chose to look at and this one describes a state that arrived. It counts
 * `active` only — an acknowledged Alarm has already reached a human, and
 * including it would keep the badge lit after the part that needed attention
 * had it.
 */

import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissions } from "@/auth/usePermission";
import { useDashboards, dashboardLabel } from "@/auth/useDashboard";
import { useAlarms } from "@/api/hooks";
import { LiveIndicator } from "@/live/LiveIndicator";
import { BrandMark } from "@/components/layout/BrandMark";
import { ThemeToggle } from "@/theme/ThemeToggle";
import { IconLogout, IconMenu } from "@/components/icons";
import {
  ADMIN_LINKS,
  DASHBOARD_ICONS,
  DEFAULT_DASHBOARD_ICON,
  groupDashboards,
} from "./navigation";

function navClass({ isActive }: { isActive: boolean }): string {
  // The active row carries a left rail as well as a tint, so it stays
  // identifiable when the tint is close to a status colour.
  return `relative flex items-center gap-2.5 rounded-control px-3 py-2 text-[13px] font-medium transition ${
    isActive
      ? "bg-accent/10 text-accent before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-full before:bg-accent"
      : "text-ink-muted hover:bg-surface-raised hover:text-ink"
  }`;
}

function GroupHeading({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-1 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint first:pt-1">
      {children}
    </div>
  );
}

export function AppShell(): JSX.Element {
  const { me, logout } = useAuth();
  const dashboards = useDashboards();
  const { has } = usePermissions();
  const adminLinks = ADMIN_LINKS.filter((link) => has(link.permission));
  const groups = groupDashboards(dashboards);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Only `active`. An acknowledged Alarm has already reached somebody, and a
  // badge that stays lit after that teaches people to stop looking at it.
  const alarmsQuery = useAlarms({ state: "active" });
  const openAlarms = alarmsQuery.data?.length ?? 0;

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
        className={`z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface-sunken transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          menuOpen
            ? "fixed inset-y-0 left-0 translate-x-0"
            : "fixed inset-y-0 left-0 -translate-x-full lg:flex"
        }`}
      >
        <div className="shrink-0 border-b border-line px-4 py-4">
          <BrandMark />
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {dashboards.length === 0 ? (
            <p className="px-3 py-2 text-xs leading-snug text-ink-faint">
              No dashboards are assigned to this account. Dashboard access is granted
              explicitly by an administrator.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <GroupHeading>{group.label}</GroupHeading>
                {group.codes.map((code) => {
                  const Icon = DASHBOARD_ICONS[code] ?? DEFAULT_DASHBOARD_ICON;
                  return (
                    <NavLink key={code} to={`/d/${code}`} className={navClass}>
                      <Icon size={17} />
                      <span className="truncate">{dashboardLabel(code)}</span>
                      {code === "alarms" && openAlarms > 0 ? (
                        <span
                          className="ml-auto rounded-full bg-bad px-1.5 py-px text-[10px] font-semibold tabular-nums text-white"
                          title={`${openAlarms} Alarm(s) open and not yet acknowledged`}
                        >
                          {openAlarms}
                        </span>
                      ) : null}
                    </NavLink>
                  );
                })}
              </div>
            ))
          )}

          {adminLinks.length > 0 ? (
            <>
              <GroupHeading>Administration</GroupHeading>
              {adminLinks.map((link) => (
                <NavLink key={link.to} to={link.to} className={navClass}>
                  <link.icon size={17} />
                  <span className="truncate">{link.label}</span>
                </NavLink>
              ))}
            </>
          ) : null}
        </nav>

        <div className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-ink">{me?.role ?? "—"}</div>
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
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="Sign out"
              aria-label="Sign out"
              className="rounded-control border border-line p-1.5 text-ink-muted transition hover:border-bad/40 hover:text-bad"
            >
              <IconLogout size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface-raised/90 px-4 py-2.5 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="rounded-control border border-line p-1.5 text-ink-muted hover:text-ink lg:hidden"
          >
            <IconMenu size={16} />
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
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
