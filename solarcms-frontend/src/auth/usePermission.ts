/**
 * A-4: action permissions.
 *
 * ⚠ Never gate on `role` (Guardrail 5). Permissions are composable rows in
 * `role_permissions` and a custom role is data rather than a schema change
 * (tender §29); `role === "admin"` breaks the moment a Client defines their own.
 *
 * ⚠ Hiding a control is **not** access control (Guardrail 6). The server refuses
 * the call regardless; this only keeps the UI coherent.
 */

import type { Me } from "@/api/schemas";
import { useAuth } from "./AuthProvider";

/**
 * Whether this session may open an admin page (A-3, migration 0046): a
 * platform administrator always; anyone else only where the page is ticked for
 * them. The page's permission is checked separately — a tick grants none. An
 * older server sends no `admin_pages`, and then nothing is filtered here.
 */
export function canOpenPage(me: Me | null | undefined, page: string | undefined): boolean {
  if (!page || !me || me.platform_admin || me.admin_pages === undefined) return true;
  return me.admin_pages.includes(page);
}

export function useAdminPage(page: string | undefined): boolean {
  const { me } = useAuth();
  return canOpenPage(me, page);
}

export type Permission =
  | "dashboard.view"
  | "alarm.acknowledge"
  | "data.export"
  | "report.generate"
  | "config.modify"
  | "user.manage"
  | "plant.manage"
  | "system.admin";

export function usePermission(permission: Permission): boolean {
  const { me } = useAuth();
  return me?.permissions.includes(permission) ?? false;
}

export function usePermissions(): {
  has: (permission: Permission) => boolean;
  hasAny: (...permissions: Permission[]) => boolean;
  all: string[];
} {
  const { me } = useAuth();
  const all = me?.permissions ?? [];
  return {
    has: (permission) => all.includes(permission),
    hasAny: (...permissions) => permissions.some((p) => all.includes(p)),
    all,
  };
}
