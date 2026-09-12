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

import { useAuth } from "./AuthProvider";

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
