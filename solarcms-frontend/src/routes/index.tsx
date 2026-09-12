/**
 * Routing.
 *
 * The dashboard routes are generated from `/auth/me` → `dashboards[]` (A-3), so
 * a User who lacks a dashboard has **no route** for it — not a hidden link, an
 * absent route. Adding a dashboard is a database row plus a component in the map
 * below (§2).
 *
 * The map is keyed by dashboard `code`, never by Plant (F-14, Guardrail 1).
 */

import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { LoginPage } from "@/components/layout/LoginPage";
import { useAuth } from "@/auth/AuthProvider";
import { useDashboards } from "@/auth/useDashboard";
import { EmptyState, LoadingState } from "@/components/state";

import { PortfolioDashboard } from "@/dashboards/PortfolioDashboard";
import { PlantListDashboard } from "@/dashboards/PlantListDashboard";
import { SinglePlantDashboard } from "@/dashboards/SinglePlantDashboard";
import { SldDashboard } from "@/dashboards/SldDashboard";
import { InverterMonitoringDashboard } from "@/dashboards/InverterMonitoringDashboard";
import { AlarmsDashboard } from "@/dashboards/AlarmsDashboard";
import { ReportsDashboard } from "@/dashboards/ReportsDashboard";

import { OnboardingWizard } from "@/admin/OnboardingWizard";
import { DeviceBindingsAdmin } from "@/admin/DeviceBindingsAdmin";
import { AlarmRulesAdmin } from "@/admin/AlarmRulesAdmin";
import { UsersAdmin } from "@/admin/UsersAdmin";
import { SystemAdmin } from "@/admin/SystemAdmin";
import { usePermission, type Permission } from "@/auth/usePermission";
import { ForbiddenState } from "@/components/state";

/** One component per dashboard code. Codes come from the database. */
const DASHBOARD_COMPONENTS: Record<string, () => JSX.Element> = {
  portfolio: PortfolioDashboard,
  plant_list: () => <PlantListDashboard variant="plant_list" />,
  plant_overview: () => <PlantListDashboard variant="plant_overview" />,
  single_plant: SinglePlantDashboard,
  sld: SldDashboard,
  inverter_monitoring: InverterMonitoringDashboard,
  alarms: AlarmsDashboard,
  reports: ReportsDashboard,
};

function DashboardRoute(): JSX.Element {
  const { code = "" } = useParams();
  const dashboards = useDashboards();

  // A-3 is checked here as well as in the navigation: a pasted URL must not
  // reach a dashboard the User was not granted. The server enforces the data
  // regardless — this only keeps the UI coherent (Guardrail 6).
  if (!dashboards.includes(code)) {
    return (
      <EmptyState
        title="Dashboard not available"
        detail="This dashboard is not assigned to your account. Dashboard access is granted explicitly by an administrator."
      />
    );
  }

  const Component = DASHBOARD_COMPONENTS[code];
  if (!Component) {
    return (
      <EmptyState
        title={`No component for "${code}"`}
        detail="This dashboard exists in the database but has no component yet. Adding one is a component plus an entry in the dashboard map."
      />
    );
  }
  return <Component />;
}

function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: JSX.Element;
}): JSX.Element {
  const allowed = usePermission(permission);
  if (!allowed) {
    return <ForbiddenState detail={`This screen requires the ${permission} permission.`} />;
  }
  return children;
}

export function AppRoutes(): JSX.Element {
  const { status } = useAuth();
  const dashboards = useDashboards();

  if (status === "loading") return <LoadingState label="Starting" />;
  if (status === "anonymous") {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  // Land on the first dashboard the server listed — it is already in sort_order,
  // so this is the platform's preferred landing page, not a hard-coded one.
  const landing = dashboards[0] ? `/d/${dashboards[0]}` : "/no-access";

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to={landing} replace />} />
        <Route path="/d/:code" element={<DashboardRoute />} />

        <Route
          path="/admin/onboarding"
          element={
            <RequirePermission permission="plant.manage">
              <OnboardingWizard />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/bindings"
          element={
            <RequirePermission permission="config.modify">
              <DeviceBindingsAdmin />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/alarm-rules"
          element={
            <RequirePermission permission="config.modify">
              <AlarmRulesAdmin />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequirePermission permission="user.manage">
              <UsersAdmin />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/system"
          element={
            <RequirePermission permission="system.admin">
              <SystemAdmin />
            </RequirePermission>
          }
        />

        <Route
          path="/no-access"
          element={
            <EmptyState
              title="No dashboards are assigned"
              detail="Your account has no dashboard access. An administrator grants it explicitly; there is no default set."
            />
          }
        />
        <Route path="*" element={<Navigate to={landing} replace />} />
      </Route>
    </Routes>
  );
}
