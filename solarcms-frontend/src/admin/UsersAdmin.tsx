/**
 * Users, Plant Assignments and dashboard access.
 *
 * ⚠ **Zero Plant Assignments means zero Plants, never all of them** (I-5,
 * Guardrail 7). A new User starts with none, and that is deliberate — the UI
 * says so rather than letting an empty list read as "unrestricted".
 *
 * Removing a User deletes the **membership**, not the person: they may belong to
 * several Clients, and the audit trail must stay attributable after they leave.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUsers } from "@/api/hooks";
import * as usersApi from "@/api/endpoints/users";
import type { User } from "@/api/schemas";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { formatDateTime } from "@/format/datetime";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";
import { DASHBOARD_CODES, dashboardLabel } from "@/auth/useDashboard";

/** Deliberately excludes super_admin: a Client Admin cannot mint a platform admin. */
const ASSIGNABLE_ROLES = ["admin", "employee", "guest"] as const;

export function UsersAdmin(): JSX.Element {
  const canManage = usePermission("user.manage");
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const usersQuery = useUsers(canManage);

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<User | null>(null);
  const [plantIds, setPlantIds] = useState<number[]>([]);
  const [dashboards, setDashboards] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    role_code: "employee",
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["users"] });
  const fail = (err: unknown, fallback: string) =>
    setError(isApiError(err) ? err.displayMessage : fallback);

  const createUser = useMutation({
    mutationFn: () => usersApi.createUser(form),
    onSuccess: () => {
      setCreating(false);
      setError(null);
      setMessage(
        `${form.email} created with no Plant Assignments — they can see nothing until Plants are assigned.`,
      );
      setForm({
        email: "",
        password: "",
        full_name: "",
        role_code: "employee",
      });
      invalidate();
    },
    onError: (err) => fail(err, "Could not create the User."),
  });

  const savePlants = useMutation({
    mutationFn: () => usersApi.setPlantAccess(selected!.id, plantIds),
    onSuccess: (result) => {
      setError(null);
      setMessage(
        result.granted === result.requested
          ? `${result.granted} Plant Assignment(s) saved.`
          : `${result.granted} of ${result.requested} granted — the rest are not visible to you, so they could not be granted.`,
      );
      invalidate();
    },
    onError: (err) => fail(err, "Could not save Plant Assignments."),
  });

  const saveDashboards = useMutation({
    mutationFn: () => usersApi.setDashboardAccess(selected!.id, dashboards),
    onSuccess: () => {
      setError(null);
      setMessage(`Dashboard access saved (${dashboards.length} dashboard(s)).`);
      invalidate();
    },
    onError: (err) => fail(err, "Could not save dashboard access."),
  });

  const toggleActive = useMutation({
    mutationFn: (user: User) =>
      usersApi.updateUser(user.id, { is_active: !user.is_active }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => fail(err, "Could not update the User."),
  });

  const removeMembership = useMutation({
    mutationFn: (user: User) => usersApi.removeUser(user.id),
    onSuccess: () => {
      setSelected(null);
      setError(null);
      setMessage(
        "Membership removed. The User row and their audit trail are kept.",
      );
      invalidate();
    },
    onError: (err) => fail(err, "Could not remove the membership."),
  });

  if (!canManage) {
    return (
      <ForbiddenState detail="Managing Users requires the user.manage permission." />
    );
  }
  if (usersQuery.isLoading) return <LoadingState label="Loading Users" />;
  if (usersQuery.isError) {
    return (
      <ErrorState
        error={usersQuery.error}
        retry={() => void usersQuery.refetch()}
      />
    );
  }

  const users = usersQuery.data ?? [];
  const visiblePlants = me?.plants ?? [];

  const columns: Column<User>[] = [
    {
      key: "email",
      header: "User",
      render: (user) => (
        <span>
          <span className="font-medium">{user.email}</span>
          {user.full_name ? (
            <span className="ml-2 text-ink-muted">{user.full_name}</span>
          ) : null}
        </span>
      ),
      sortValue: (user) => user.email,
      filterValue: (user) => `${user.email} ${user.full_name ?? ""}`,
    },
    {
      key: "role",
      header: "Role",
      width: "120px",
      // Displayed, never gated on (Guardrail 5): permissions decide what renders.
      render: (user) => <Badge tone="neutral">{user.role_code}</Badge>,
      sortValue: (user) => user.role_code,
    },
    {
      key: "plants",
      header: "Plants",
      align: "right",
      width: "110px",
      render: (user) =>
        user.assigned_plants === 0 ? (
          <span
            className="text-warn"
            title="Zero assignments means zero Plants, not full access. This User currently sees nothing."
          >
            0
          </span>
        ) : (
          user.assigned_plants
        ),
      sortValue: (user) => user.assigned_plants,
    },
    {
      key: "active",
      header: "Active",
      width: "90px",
      render: (user) =>
        user.is_active ? (
          <Badge tone="ok">yes</Badge>
        ) : (
          <Badge tone="bad">no</Badge>
        ),
      sortValue: (user) => String(user.is_active),
    },
    {
      key: "last_login",
      header: "Last login",
      width: "170px",
      render: (user) => (
        <span className="font-mono text-xs text-ink-muted">
          {user.last_login_at ? formatDateTime(user.last_login_at) : "never"}
        </span>
      ),
      sortValue: (user) =>
        user.last_login_at ? Date.parse(user.last_login_at) : null,
    },
    {
      key: "actions",
      header: "",
      width: "150px",
      render: (user) => (
        <span className="flex justify-end gap-1">
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(user);
              setPlantIds([]);
              setDashboards([]);
              setMessage(null);
              setError(null);
            }}
          >
            Access
          </Button>
          <Button
            variant="ghost"
            onClick={() => toggleActive.mutate(user)}
            title="A deactivated User is ejected on their next request, not fifteen minutes later."
          >
            {user.is_active ? "Disable" : "Enable"}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Users of this Client. Access is granted explicitly, never by
            default.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setCreating((previous) => !previous)}
        >
          {creating ? "Cancel" : "New User"}
        </Button>
      </div>

      {message ? (
        <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </div>
      ) : null}

      {creating ? (
        <Panel
          title="New User"
          subtitle="Starts with zero Plants and zero dashboards."
        >
          <div className="grid max-w-3xl grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Email" required>
              <input
                type="email"
                value={form.email}
                onChange={(event) =>
                  setForm({ ...form, email: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Full name" required>
              <input
                value={form.full_name}
                onChange={(event) =>
                  setForm({ ...form, full_name: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field label="Password" required>
              <input
                type="password"
                value={form.password}
                onChange={(event) =>
                  setForm({ ...form, password: event.target.value })
                }
                className={inputClass}
              />
            </Field>
            <Field
              label="Role"
              hint="A Client Admin cannot create a platform administrator."
            >
              <select
                value={form.role_code}
                onChange={(event) =>
                  setForm({ ...form, role_code: event.target.value })
                }
                className={inputClass}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button
            variant="primary"
            className="mt-4"
            disabled={
              !form.email ||
              !form.password ||
              !form.full_name ||
              createUser.isPending
            }
            onClick={() => createUser.mutate()}
          >
            {createUser.isPending ? "Creating…" : "Create User"}
          </Button>
        </Panel>
      ) : null}

      {selected ? (
        <Panel
          title={`Access — ${selected.email}`}
          subtitle="Both lists replace what is there; anything unticked is revoked."
          actions={
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold text-ink">
                Plant Assignments <span className="text-ink-faint">(A-2)</span>
              </h3>
              <p className="mt-1 text-[11px] leading-snug text-ink-faint">
                Currently {selected.assigned_plants} assigned. An empty
                selection grants nothing — it is not a shortcut for "all
                Plants".
              </p>
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
                {visiblePlants.length === 0 ? (
                  <p className="text-xs text-ink-faint">
                    You have no Plants to grant.
                  </p>
                ) : (
                  visiblePlants.map((plant) => (
                    <label
                      key={plant.id}
                      className="flex items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={plantIds.includes(plant.id)}
                        onChange={() =>
                          setPlantIds((previous) =>
                            previous.includes(plant.id)
                              ? previous.filter((id) => id !== plant.id)
                              : [...previous, plant.id],
                          )
                        }
                      />
                      {plant.code} — {plant.name}
                    </label>
                  ))
                )}
              </div>
              <Button
                className="mt-2"
                disabled={savePlants.isPending}
                onClick={() => savePlants.mutate()}
              >
                {savePlants.isPending
                  ? "Saving…"
                  : `Replace with ${plantIds.length} Plant(s)`}
              </Button>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-ink">
                Dashboards <span className="text-ink-faint">(A-3)</span>
              </h3>
              <p className="mt-1 text-[11px] leading-snug text-ink-faint">
                Which dashboards exist for this User. A dashboard they lack has
                no route at all.
              </p>
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
                {DASHBOARD_CODES.map((code) => (
                  <label key={code} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={dashboards.includes(code)}
                      onChange={() =>
                        setDashboards((previous) =>
                          previous.includes(code)
                            ? previous.filter((entry) => entry !== code)
                            : [...previous, code],
                        )
                      }
                    />
                    {dashboardLabel(code)}
                  </label>
                ))}
              </div>
              <Button
                className="mt-2"
                disabled={saveDashboards.isPending}
                onClick={() => saveDashboards.mutate()}
              >
                {saveDashboards.isPending
                  ? "Saving…"
                  : `Replace with ${dashboards.length} dashboard(s)`}
              </Button>
            </div>
          </div>

          <div className="mt-6 border-t border-line pt-4">
            <Button
              variant="danger"
              disabled={
                selected.id === me?.user_id || removeMembership.isPending
              }
              title={
                selected.id === me?.user_id
                  ? "You cannot remove your own membership."
                  : "Removes the membership only. The User and their audit trail are kept."
              }
              onClick={() => removeMembership.mutate(selected)}
            >
              Remove from this Client
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel title={`${users.length} User(s)`}>
        <DataTable
          rows={users}
          columns={columns}
          rowKey={(user) => user.id}
          filterPlaceholder="Filter Users…"
        />
      </Panel>
    </div>
  );
}
