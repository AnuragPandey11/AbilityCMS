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
 * behind a menu button.
 *
 * ── From `lg` up it can fold to an icon rail ────────────────────────────────
 * 240px is a lot to give a menu on a laptop showing a Single Line Diagram, so
 * the header's toggle narrows it to 72px of icons and remembers the choice per
 * browser. The rail keeps everything that is not merely a label: the active
 * row's marker, the open-Alarm count (see below — it matters most precisely
 * when somebody has put the menu away), group breaks as rules, and Sign out.
 * Labels become tooltips and stay the links' accessible names. Every rail class
 * is `lg:`-prefixed, so the slide-over below `lg` always opens in full.
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
import { useAlarms, useDataIssuesSummary } from "@/api/hooks";
import { LiveIndicator } from "@/live/LiveIndicator";
import { SystemHealthPill } from "@/components/layout/SystemHealthPill";
import { BrandMark } from "@/components/layout/BrandMark";
import { HeaderSlotProvider } from "@/components/layout/HeaderSlot";
import { ThemeToggle } from "@/theme/ThemeToggle";
import { IconLogout, IconMenu, IconSidebar } from "@/components/icons";
import { useSidebarCollapsed } from "@/state/useSidebarCollapsed";
import {
  ADMIN_LINKS,
  DASHBOARD_ICONS,
  DEFAULT_DASHBOARD_ICON,
  groupDashboards,
} from "./navigation";

function navClass(collapsed: boolean) {
  // The active row carries a left rail as well as a tint, so it stays
  // identifiable when the tint is close to a status colour. The sidebar is
  // navy in both themes, so every colour here is a `nav-*` token.
  return ({ isActive }: { isActive: boolean }): string =>
    `relative flex items-center gap-2.5 rounded-control px-3 py-2 text-[13px] font-medium transition ${
      collapsed ? "lg:justify-center lg:px-0" : ""
    } ${
      isActive
        ? "bg-nav-accent/[0.14] text-nav-accent before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-full before:bg-nav-accent"
        : "text-nav-muted hover:bg-nav-ink/[0.06] hover:text-nav-ink"
    }`;
}

/** On the rail a label is a tooltip; `sr-only` keeps it the link's name. */
function NavLabel({ collapsed, children }: { collapsed: boolean; children: string }): JSX.Element {
  return <span className={`truncate ${collapsed ? "lg:sr-only" : ""}`}>{children}</span>;
}

function GroupHeading({
  children,
  collapsed,
  leading,
}: {
  children: string;
  collapsed: boolean;
  /** The first group on the rail needs no rule above it. */
  leading: boolean;
}): JSX.Element {
  return (
    <div className="px-1 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-nav-faint first:pt-1">
      <span className={collapsed ? "lg:sr-only" : undefined}>{children}</span>
      {collapsed && !leading ? (
        <span aria-hidden className="mx-2 hidden border-t border-nav-line lg:block" />
      ) : null}
    </div>
  );
}

export function AppShell(): JSX.Element {
  const { me, logout } = useAuth();
  const dashboards = useDashboards();
  const { has } = usePermissions();
  const adminLinks = ADMIN_LINKS.filter((link) => has(link.permission));
  // `has` is passed so the menu cannot offer a dashboard whose screen refuses.
  const groups = groupDashboards(dashboards, has);
  const [menuOpen, setMenuOpen] = useState(false);
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  // State rather than a ref, so the page re-renders into the slot once it
  // exists. See `HeaderSlot` for why the first frame renders nothing.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const location = useLocation();

  // Only `active`. An acknowledged Alarm has already reached somebody, and a
  // badge that stays lit after that teaches people to stop looking at it.
  const alarmsQuery = useAlarms({ state: "active" });
  const openAlarms = alarmsQuery.data?.length ?? 0;

  // Data being lost or wrong, not yet fixed or marked as known. Never setup,
  // which can stand for months: a badge that never goes out is not read.
  const dataIssuesQuery = useDataIssuesSummary(has("config.modify"));
  const openDataIssues = dataIssuesQuery.data?.open_urgent ?? 0;

  // A-1. The active Client is context, and switching resets everything. Named
  // rather than numbered: "Client #2" tells someone their own company's row id
  // and nothing else.
  const clientLabel = `${
    me?.client_name ??
    me?.client_code ??
    (me?.client_id != null ? `Client #${me.client_id}` : "no Client")
  }${me?.platform_admin ? " · platform admin" : ""}`;

  // Navigating closes it. A drawer left open over the page you just asked for
  // is the single most irritating thing a mobile menu can do.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-ground flex min-h-screen text-ink">
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
        id="app-sidebar"
        className={`app-nav z-40 flex w-60 shrink-0 flex-col border-r border-nav-line transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          collapsed ? "lg:w-[4.5rem]" : ""
        } ${
          menuOpen
            ? "fixed inset-y-0 left-0 translate-x-0"
            : "fixed inset-y-0 left-0 -translate-x-full lg:flex"
        }`}
      >
        <div className={`shrink-0 border-b border-nav-line px-4 py-4 ${collapsed ? "lg:px-3" : ""}`}>
          <div className={collapsed ? "lg:hidden" : undefined}>
            <BrandMark onNavy />
          </div>
          {/* The same 44px as the full logo, so the rows below do not jump. */}
          {collapsed ? (
            <div className="hidden h-11 items-center justify-center lg:flex">
              <BrandMark onNavy compact height={30} />
            </div>
          ) : null}
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {dashboards.length === 0 ? (
            <p className={`px-3 py-2 text-xs leading-snug text-nav-faint ${collapsed ? "lg:hidden" : ""}`}>
              No dashboards are assigned to this account. Dashboard access is granted
              explicitly by an administrator.
            </p>
          ) : (
            groups.map((group, index) => (
              <div key={group.label}>
                <GroupHeading collapsed={collapsed} leading={index === 0}>
                  {group.label}
                </GroupHeading>
                {group.codes.map((code) => {
                  const Icon = DASHBOARD_ICONS[code] ?? DEFAULT_DASHBOARD_ICON;
                  const label = dashboardLabel(code);
                  return (
                    <NavLink
                      key={code}
                      to={`/d/${code}`}
                      className={navClass(collapsed)}
                      title={collapsed ? label : undefined}
                    >
                      <Icon size={17} />
                      <NavLabel collapsed={collapsed}>{label}</NavLabel>
                      {code === "alarms" && openAlarms > 0 ? (
                        // On the rail it rides on the icon's corner: this count
                        // is the reason to glance at a menu somebody put away.
                        <span
                          className={`ml-auto rounded-full bg-bad px-1.5 py-px text-[10px] font-semibold tabular-nums text-white ${
                            collapsed ? "lg:absolute lg:right-1 lg:top-0.5 lg:ml-0 lg:px-1 lg:ring-2 lg:ring-nav" : ""
                          }`}
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
              <GroupHeading collapsed={collapsed} leading={dashboards.length === 0}>
                Administration
              </GroupHeading>
              {adminLinks.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className={navClass(collapsed)}
                  title={collapsed ? link.label : undefined}
                >
                  <link.icon size={17} />
                  <NavLabel collapsed={collapsed}>{link.label}</NavLabel>
                  {link.to === "/admin/data-issues" && openDataIssues > 0 ? (
                    // Amber, not red: data that needs attention, not an Alarm.
                    <span
                      className={`ml-auto rounded-full bg-warn px-1.5 py-px text-[10px] font-semibold tabular-nums text-black/80 ${
                        collapsed ? "lg:absolute lg:right-1 lg:top-0.5 lg:ml-0 lg:px-1 lg:ring-2 lg:ring-nav" : ""
                      }`}
                      title={`${openDataIssues} data issue(s) open: data being lost or looking wrong`}
                    >
                      {openDataIssues}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </>
          ) : null}
        </nav>

        <div className="shrink-0 border-t border-nav-line p-3">
          <div className={`flex items-center gap-2 ${collapsed ? "lg:justify-center" : ""}`}>
            <div className={`min-w-0 flex-1 ${collapsed ? "lg:hidden" : ""}`}>
              <div className="truncate text-xs font-medium text-nav-ink">{me?.role ?? "—"}</div>
              <div
                className="truncate text-[11px] text-nav-faint"
                title={
                  me?.client_id === null || me?.client_id === undefined
                    ? "No active Client. A platform administrator is a member of none."
                    : `Client #${me.client_id}`
                }
              >
                {clientLabel}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              // On the rail the account block is hidden, so the one control
              // left says whose session it ends.
              title={collapsed ? `Sign out (${me?.role ?? "—"} · ${clientLabel})` : "Sign out"}
              aria-label="Sign out"
              className="rounded-control border border-nav-line p-1.5 text-nav-muted transition hover:border-bad/60 hover:text-bad"
            >
              <IconLogout size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface/85 px-4 py-2.5 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="rounded-control border border-line p-1.5 text-ink-muted hover:text-ink lg:hidden"
          >
            <IconMenu size={16} />
          </button>
          {/* The same place from `lg` up, and a long way from Sign out. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            className="hidden rounded-control border border-line p-1.5 text-ink-muted hover:text-ink lg:inline-flex"
          >
            <IconSidebar size={16} />
          </button>
          {/* Filled by the page, if it has an identity worth pinning. */}
          <div ref={setHeaderSlot} className="flex min-w-0 flex-1 items-center" />
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {/* Only for a Super Admin, and only when something is wrong. */}
            <SystemHealthPill />
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
          <HeaderSlotProvider value={headerSlot}>
            <Outlet />
          </HeaderSlotProvider>
        </main>
      </div>
    </div>
  );
}
