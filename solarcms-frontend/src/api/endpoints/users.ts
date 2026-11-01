import { z } from "zod";
import { request } from "../client";
import { UserSchema, parse, type User } from "../schemas";

export async function listUsers(): Promise<User[]> {
  return parse(z.array(UserSchema), await request("/users"), "GET /users");
}

/**
 * Create a User in the caller's Client. The role is restricted server-side to
 * admin/employee/guest — a Client Admin cannot mint a platform administrator.
 *
 * A new User starts with **zero** Plant Assignments and therefore sees zero
 * Plants. That is deliberate (I-5); the UI must not present it as a bug.
 */
export async function createUser(input: {
  email: string;
  password: string;
  full_name: string;
  role_code: string;
  /** Required of a platform administrator, ignored for a Client Admin. */
  client_id?: number;
  /** The tabs ticked on the form, given in the same transaction (A-3). */
  dashboard_codes?: string[];
}): Promise<unknown> {
  const { dashboard_codes, ...params } = input;
  return request("/users", {
    method: "POST",
    params: { ...params },
    body: { dashboard_codes: dashboard_codes ?? [] },
  });
}

/** One tab: a screen, or an admin page with the role permission it also needs. */
export const AccessTabSchema = z.object({
  code: z.string(),
  name: z.string(),
  kind: z.enum(["screen", "admin"]).catch("screen"),
  permission: z.string().nullable(),
});
export type AccessTab = z.infer<typeof AccessTabSchema>;

export const AccessCatalogueSchema = z.object({
  tabs: z.array(AccessTabSchema),
  /** Per role, the tabs it can use: every screen, and the admin pages it holds the permission for. */
  offered_by_role: z.record(z.array(z.string())),
  /** The tabs this caller may give; null for a platform administrator, who may give any. */
  givable: z.array(z.string()).nullable(),
  /** Whether this caller sets a Client Admin's tabs — a platform administrator only. */
  sets_client_admin_tabs: z.boolean(),
});
export type AccessCatalogue = z.infer<typeof AccessCatalogueSchema>;

export async function accessCatalogue(): Promise<AccessCatalogue> {
  return parse(AccessCatalogueSchema, await request("/users/access-catalogue"),
    "GET /users/access-catalogue");
}

export async function updateUser(
  userId: number,
  body: {
    full_name?: string | null;
    is_active?: boolean | null;
    role_code?: string | null;
    password?: string | null;
  },
): Promise<unknown> {
  return request(`/users/${userId}`, { method: "PATCH", body });
}

/** Replaces the Plant Assignments (A-2). The body is a bare array of ids. */
export async function setPlantAccess(
  userId: number,
  plantIds: number[],
): Promise<{ user_id: number; requested: number; granted: number }> {
  return (await request(`/users/${userId}/plants`, {
    method: "PUT",
    body: plantIds,
  })) as { user_id: number; requested: number; granted: number };
}

/** Replaces dashboard access (A-3). The body is a bare array of codes. */
export async function setDashboardAccess(
  userId: number,
  dashboardCodes: string[],
): Promise<unknown> {
  return request(`/users/${userId}/dashboards`, {
    method: "PUT",
    body: dashboardCodes,
  });
}

/**
 * Removes the **membership**, not the User row: a person may belong to several
 * Clients, and the audit trail must stay attributable after someone leaves.
 */
export async function removeUser(userId: number): Promise<void> {
  await request(`/users/${userId}`, { method: "DELETE" });
}
