/**
 * The application frame.
 *
 * Navigation is built from `/auth/me` → `dashboards[]` (A-3). A User with two
 * dashboards sees exactly two entries, and the routes for the rest do not
 * exist — not hidden, absent (§2, §3.4).
 */

import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { usePermissions } from "@/auth/usePermission";
import { useDashboards, dashboardLabel } from "@/auth/useDashboard";
import { LiveIndicator } from "@/live/LiveIndicator";
import { Button } from "@/components/ui";
import { BrandMark } from "@/components/layout/BrandMark";
import { ThemeToggle } from "@/theme/ThemeToggle";

const ADMIN_LINKS = [
  { to: "/admin/onboarding", label: "Onboarding", permission: "plant.manage" },
  { to: "/admin/bindings", label: "Device Bindings", permission: "config.modify" },
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

  return (
    <div className="flex min-h-screen bg-surface text-ink">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface-sunken">
        <div className="border-b border-line px-4 py-4">
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

        <div className="border-t border-line p-3">
          <div className="truncate text-xs text-ink">{me?.role ?? "—"}</div>
          <div className="truncate text-[11px] text-ink-faint">
            {/* A-1. The active Client is context, and switching resets everything. */}
            Client #{me?.client_id ?? "—"}
            {me?.platform_admin ? " · platform admin" : ""}
          </div>
          <Button className="mt-2 w-full" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface-raised px-6 py-2.5">
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator />
            <span className="text-xs text-ink-faint">
              {me?.plants.length ?? 0} Plant(s) visible
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-x-hidden p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
