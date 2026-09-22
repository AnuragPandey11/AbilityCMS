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
import { PlantsDashboard } from "@/dashboards/PlantsDashboard";
import { SinglePlantDashboard } from "@/dashboards/SinglePlantDashboard";
import { SldDashboard } from "@/dashboards/SldDashboard";
import { InverterMonitoringDashboard } from "@/dashboards/InverterMonitoringDashboard";
import { AlarmsDashboard } from "@/dashboards/AlarmsDashboard";
import { ReportsDashboard } from "@/dashboards/ReportsDashboard";

import { OnboardingWizard } from "@/admin/OnboardingWizard";
import { PlantHierarchyEditor } from "@/admin/PlantHierarchyEditor";
import { ClientsAdmin } from "@/admin/ClientsAdmin";
import { PlantEditor } from "@/admin/PlantEditor";
import { DeviceBindingsAdmin } from "@/admin/DeviceBindingsAdmin";
import { AlarmRulesAdmin } from "@/admin/AlarmRulesAdmin";
import { UsersAdmin } from "@/admin/UsersAdmin";
import { SystemAdmin } from "@/admin/SystemAdmin";
import { usePermission, type Permission } from "@/auth/usePermission";
import { ArtPreview } from "@/dev/ArtPreview";
import { ChartPreview } from "@/dev/ChartPreview";
import { ForbiddenState } from "@/components/state";

/** One component per dashboard code. Codes come from the database. */
const DASHBOARD_COMPONENTS: Record<string, () => JSX.Element> = {
  portfolio: PortfolioDashboard,
  // ⚠ Both codes render the same screen. `plant_overview` (cards ordered by
  // urgency) and `plant_list` (a sortable table) drew the same Plants from the
  // same hook and differed only in shape, so they are now one screen with a
  // view toggle. Both entries stay so a granted code and a pasted URL still
  // resolve (A-3); the navigation collapses them into one (see `navigation.ts`).
  plant_overview: PlantsDashboard,
  plant_list: PlantsDashboard,
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
        {/* Development contact sheet for the equipment artwork. Not navigable. */}
        <Route path="/dev/art" element={<ArtPreview />} />
        {/* Chart edge-case contact sheet. Not navigable. */}
        <Route path="/dev/charts" element={<ChartPreview />} />

        <Route
          path="/admin/onboarding"
          element={
            <RequirePermission permission="plant.manage">
              <OnboardingWizard />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/clients"
          element={
            <RequirePermission permission="system.admin">
              <ClientsAdmin />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/plant-setup"
          element={
            <RequirePermission permission="plant.manage">
              <PlantEditor />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/hierarchy"
          element={
            <RequirePermission permission="plant.manage">
              <PlantHierarchyEditor />
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
