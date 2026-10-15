/**
 * Users, Plant Assignments and dashboard access — and each User's name, role
 * and password.
 *
 * ⚠ **Zero Plant Assignments means zero Plants, never all of them** (I-5,
 * Guardrail 7). A new User starts with none, and that is deliberate — the UI
 * says so rather than letting an empty list read as "unrestricted".
 *
 * ⚠ **The Manage panel opens with what the User holds now ticked.** Both lists
 * are replaced whole on save (`PUT /users/{id}/plants`, `/dashboards`), and the
 * panel used to open with every box clear — so granting one Plant to somebody
 * who had five silently took the other five away. Each save button now says
 * what it will add and remove, and does nothing when nothing changed.
 *
 * Removing a User deletes the **membership**, not the person: they may belong to
 * several Clients, and the audit trail must stay attributable after they leave.
 * For the same reason a password set here is that person's one password, for
 * every Client they sign in to.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as clientsApi from "@/api/endpoints/clients";
import { qk } from "@/api/queryKeys";
import { useUsers } from "@/api/hooks";
import * as usersApi from "@/api/endpoints/users";
import type { User } from "@/api/schemas";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, PasswordInput, inputClass } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { formatDateTime } from "@/format/datetime";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";
import { DASHBOARD_CODES, dashboardLabel } from "@/auth/useDashboard";

/** Deliberately excludes super_admin: a Client Admin cannot mint a platform admin. */
const ASSIGNABLE_ROLES = ["admin", "employee", "guest"] as const;

/** The role as the rest of the application names it, never its code. */
export const ROLE_LABEL: Record<string, string> = {
  admin: "Client Admin",
  employee: "Client Employee",
  guest: "Guest",
};

const roleLabel = (code: string): string => ROLE_LABEL[code] ?? code;

/** The server's minimum for a password set on an existing User (`UserUpdate`). */
export const PASSWORD_MIN = 12;

/**
 * `plant_overview` and `plant_list` are one screen with two codes (see
 * `navigation.ts`), so the checklist shows them as one box: ticked when either
 * is held, and granting or revoking both together.
 */
const PLANTS_SCREEN = ["plant_overview", "plant_list"];
const DASHBOARD_BOXES: { label: string; codes: string[] }[] = DASHBOARD_CODES.filter(
  (code) => code !== "plant_list",
).map((code) =>
  code === "plant_overview"
    ? { label: dashboardLabel(code), codes: PLANTS_SCREEN }
    : { label: dashboardLabel(code), codes: [code] },
);

/** What saving `next` over `current` would do, said before it is done. */
export function describeChange<T>(current: T[], next: T[]): {
  added: number;
  removed: number;
  changed: boolean;
} {
  const before = new Set(current);
  const after = new Set(next);
  const added = [...after].filter((item) => !before.has(item)).length;
  const removed = [...before].filter((item) => !after.has(item)).length;
  return { added, removed, changed: added + removed > 0 };
}

function saveLabel(noun: string, change: { added: number; removed: number; changed: boolean }): string {
  if (!change.changed) return `No changes to ${noun}`;
  const parts = [
    change.added > 0 ? `add ${change.added}` : null,
    change.removed > 0 ? `remove ${change.removed}` : null,
  ].filter(Boolean);
  return `Save ${noun} (${parts.join(", ")})`;
}

export function UsersAdmin(): JSX.Element {
  const canManage = usePermission("user.manage");
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const usersQuery = useUsers(canManage);
  // A platform administrator belongs to no Client, so the new User's Client is
  // chosen here. `GET /clients` is Super Admin only; a Client Admin never asks.
  const isPlatformAdmin = me?.platform_admin === true;
  // Every change to an existing User acts on the Client the session is signed
  // into. A platform administrator signed into none is refused by the server,
  // so the panel says how to get there instead of offering buttons that fail.
  const actsOnNoClient = isPlatformAdmin && (me?.client_id ?? null) === null;
  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: canManage && isPlatformAdmin,
  });
  const [clientId, setClientId] = useState<number | "">("");

  const [creating, setCreating] = useState(false);
  // The id, not the row: the row is re-read after every save, and a copy held
  // here would go on showing what the User had before it.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [plantIds, setPlantIds] = useState<number[]>([]);
  const [dashboards, setDashboards] = useState<string[]>([]);
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("employee");
  const [newPassword, setNewPassword] = useState("");
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
  const fail = (err: unknown, fallback: string) => {
    setMessage(null);
    setError(isApiError(err) ? err.displayMessage : fallback);
  };
  const done = (text: string) => {
    setError(null);
    setMessage(text);
    invalidate();
  };

  const users = usersQuery.data ?? [];
  const selected = users.find((user) => user.id === selectedId) ?? null;

  const createUser = useMutation({
    mutationFn: () =>
      usersApi.createUser({
        ...form,
        ...(isPlatformAdmin && clientId !== "" ? { client_id: clientId } : {}),
      }),
    onSuccess: () => {
      setCreating(false);
      done(
        `${form.email} created with no Plant Assignments — they can see nothing until Plants are assigned. Press Manage on their row.`,
      );
      setForm({
        email: "",
        password: "",
        full_name: "",
        role_code: "employee",
      });
    },
    onError: (err) => fail(err, "Could not create the User."),
  });

  const savePlants = useMutation({
    mutationFn: () => usersApi.setPlantAccess(selected!.id, plantIds),
    onSuccess: (result) =>
      done(
        result.granted === result.requested
          ? `Plant access saved: ${result.granted} Plant(s).`
          : `${result.granted} of ${result.requested} granted — the rest are not visible to you, so they could not be granted.`,
      ),
    onError: (err) => fail(err, "Could not save Plant Assignments."),
  });

  const saveDashboards = useMutation({
    mutationFn: () => usersApi.setDashboardAccess(selected!.id, dashboards),
    onSuccess: () =>
      done(`Dashboard access saved: ${new Set(dashboards.map(boxOf)).size} screen(s).`),
    onError: (err) => fail(err, "Could not save dashboard access."),
  });

  const saveDetails = useMutation({
    mutationFn: (body: { full_name?: string; role_code?: string }) =>
      usersApi.updateUser(selected!.id, body),
    onSuccess: (_result, body) =>
      done(
        body.role_code
          ? `${selected?.email ?? "User"} is now ${roleLabel(body.role_code)}. It takes effect on their next click.`
          : `${selected?.email ?? "User"} updated.`,
      ),
    onError: (err) => fail(err, "Could not save the change."),
  });

  const setPassword = useMutation({
    mutationFn: () => usersApi.updateUser(selected!.id, { password: newPassword }),
    onSuccess: () => {
      const email = selected?.email ?? "the User";
      setNewPassword("");
      done(`Password changed for ${email}. Give them the new one; the old one no longer works.`);
    },
    onError: (err) => fail(err, "Could not change the password."),
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
      setSelectedId(null);
      done("Membership removed. The User row and their audit trail are kept.");
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

  const visiblePlants = me?.plants ?? [];

  /** Open the Manage panel with what the User holds now — never blank. */
  const manage = (user: User) => {
    setSelectedId(user.id);
    setPlantIds(user.plant_ids);
    setDashboards(user.dashboards);
    setFullName(user.full_name ?? "");
    setRole(user.role_code);
    setNewPassword("");
    setMessage(null);
    setError(null);
  };

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
      width: "150px",
      // Displayed, never gated on (Guardrail 5): permissions decide what renders.
      render: (user) => <Badge tone="neutral">{roleLabel(user.role_code)}</Badge>,
      sortValue: (user) => user.role_code,
      filterValue: (user) => roleLabel(user.role_code),
    },
    {
      key: "plants",
      header: "Plants",
      align: "right",
      width: "110px",
      render: (user) =>
        user.role_code === "admin" ? (
          <span
            className="text-ink-muted"
            title="A Client Admin sees every Plant of their Client, whatever is assigned."
          >
            all
          </span>
        ) : user.assigned_plants === 0 ? (
          <span
            className="text-warn"
            title="Zero assignments means zero Plants, not full access. This User currently sees nothing."
          >
            0
          </span>
        ) : (
          user.assigned_plants
        ),
      sortValue: (user) => (user.role_code === "admin" ? Number.MAX_SAFE_INTEGER : user.assigned_plants),
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
      width: "160px",
      render: (user) => (
        <span className="flex justify-end gap-1">
          <Button
            variant="ghost"
            onClick={() => manage(user)}
            title="Name, role, password, Plants and screens"
          >
            Manage
          </Button>
          <Button
            variant="ghost"
            disabled={actsOnNoClient}
            onClick={() => toggleActive.mutate(user)}
            title={
              actsOnNoClient
                ? "Sign into this User's Client first (System → switch to)."
                : "A deactivated User is ejected on their next request, not fifteen minutes later."
            }
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
            {isPlatformAdmin ? (
              <Field
                label="Client"
                required
                hint="You belong to no Client, so say which this User is for."
              >
                <select
                  value={clientId}
                  onChange={(event) =>
                    setClientId(
                      event.target.value === "" ? "" : Number(event.target.value),
                    )
                  }
                  className={inputClass}
                >
                  <option value="">Choose a Client…</option>
                  {(clientsQuery.data ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name} ({client.code})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
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
                {ASSIGNABLE_ROLES.map((code) => (
                  <option key={code} value={code}>
                    {roleLabel(code)}
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
              (isPlatformAdmin && clientId === "") ||
              createUser.isPending
            }
            onClick={() => createUser.mutate()}
          >
            {createUser.isPending ? "Creating…" : "Create User"}
          </Button>
        </Panel>
      ) : null}

      {selected ? (
        <ManagePanel
          user={selected}
          isSelf={selected.id === me?.user_id}
          actsOnNoClient={actsOnNoClient}
          visiblePlants={visiblePlants}
          plantIds={plantIds}
          setPlantIds={setPlantIds}
          dashboards={dashboards}
          setDashboards={setDashboards}
          fullName={fullName}
          setFullName={setFullName}
          role={role}
          setRole={setRole}
          newPassword={newPassword}
          setNewPassword={setNewPassword}
          onClose={() => setSelectedId(null)}
          onSavePlants={() => savePlants.mutate()}
          savingPlants={savePlants.isPending}
          onSaveDashboards={() => saveDashboards.mutate()}
          savingDashboards={saveDashboards.isPending}
          onSaveDetails={(body) => saveDetails.mutate(body)}
          savingDetails={saveDetails.isPending}
          onSetPassword={() => setPassword.mutate()}
          settingPassword={setPassword.isPending}
          onRemove={() => removeMembership.mutate(selected)}
          removing={removeMembership.isPending}
        />
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

/** Which checklist box a dashboard code belongs to, so two codes count once. */
function boxOf(code: string): string {
  return PLANTS_SCREEN.includes(code) ? "plant_overview" : code;
}

function ManagePanel({
  user,
  isSelf,
  actsOnNoClient,
  visiblePlants,
  plantIds,
  setPlantIds,
  dashboards,
  setDashboards,
  fullName,
  setFullName,
  role,
  setRole,
  newPassword,
  setNewPassword,
  onClose,
  onSavePlants,
  savingPlants,
  onSaveDashboards,
  savingDashboards,
  onSaveDetails,
  savingDetails,
  onSetPassword,
  settingPassword,
  onRemove,
  removing,
}: {
  user: User;
  isSelf: boolean;
  actsOnNoClient: boolean;
  visiblePlants: { id: number; code: string; name: string }[];
  plantIds: number[];
  setPlantIds: (update: (previous: number[]) => number[]) => void;
  dashboards: string[];
  setDashboards: (update: (previous: string[]) => string[]) => void;
  fullName: string;
  setFullName: (value: string) => void;
  role: string;
  setRole: (value: string) => void;
  newPassword: string;
  setNewPassword: (value: string) => void;
  onClose: () => void;
  onSavePlants: () => void;
  savingPlants: boolean;
  onSaveDashboards: () => void;
  savingDashboards: boolean;
  onSaveDetails: (body: { full_name?: string; role_code?: string }) => void;
  savingDetails: boolean;
  onSetPassword: () => void;
  settingPassword: boolean;
  onRemove: () => void;
  removing: boolean;
}): JSX.Element {
  const plantChange = describeChange(user.plant_ids, plantIds);
  // Compared by box, so holding one of the two Plants codes and saving both is
  // not reported as a change nobody made.
  const dashboardChange = describeChange(
    [...new Set(user.dashboards.map(boxOf))],
    [...new Set(dashboards.map(boxOf))],
  );
  const nameChanged = fullName.trim() !== (user.full_name ?? "") && fullName.trim() !== "";
  const roleChanged = role !== user.role_code;
  const passwordShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN;
  const blocked = actsOnNoClient;

  const toggleBox = (codes: string[], on: boolean) =>
    setDashboards((previous) =>
      on
        ? [...new Set([...previous, ...codes])]
        : previous.filter((code) => !codes.includes(code)),
    );

  return (
    <Panel
      title={`Manage — ${user.email}`}
      subtitle="Ticked boxes are what this person has now. Each Save replaces that list with what is ticked."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {blocked ? (
        <p className="mb-4 rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-ink">
          You are signed into no Client, so changes to an existing User are refused. Go to{" "}
          <strong>System</strong>, press <strong>switch to</strong> on this User&apos;s Client, and
          come back here.
        </p>
      ) : null}

      {/* ── Name and role ─────────────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-ink">Name and role</h3>
        <div className="mt-2 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Full name">
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="Role"
            hint={
              isSelf
                ? "You cannot change your own role — ask another administrator."
                : "Takes effect on their next click. A Client Admin sees every Plant and screen."
            }
          >
            <select
              value={role}
              disabled={isSelf}
              onChange={(event) => setRole(event.target.value)}
              className={inputClass}
              aria-label={`Role of ${user.email}`}
            >
              {ASSIGNABLE_ROLES.map((code) => (
                <option key={code} value={code}>
                  {roleLabel(code)}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              disabled={blocked || savingDetails || (!nameChanged && !roleChanged)}
              onClick={() =>
                onSaveDetails({
                  ...(nameChanged ? { full_name: fullName.trim() } : {}),
                  ...(roleChanged ? { role_code: role } : {}),
                })
              }
            >
              {savingDetails ? "Saving…" : "Save name and role"}
            </Button>
          </div>
        </div>
        {roleChanged && role !== "admin" && user.role_code === "admin" ? (
          <p className="mt-2 text-[11px] leading-snug text-warn">
            As {roleLabel(role)} they will see only the Plants and screens ticked below — tick
            them before or right after saving, or they will see nothing.
          </p>
        ) : null}
      </section>

      {/* ── Password ──────────────────────────────────────────────────── */}
      <section className="mt-5 border-t border-line pt-4">
        <h3 className="text-xs font-semibold text-ink">Password</h3>
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">
          Sets a new password for this person. It is their one password for every Client they
          belong to. At least {PASSWORD_MIN} characters.
        </p>
        <div className="mt-2 flex max-w-xl flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <PasswordInput
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              placeholder="New password"
              aria-label={`New password for ${user.email}`}
            />
            {passwordShort ? (
              <p className="mt-1 text-[11px] text-warn">
                {PASSWORD_MIN - newPassword.length} more character(s) needed.
              </p>
            ) : null}
          </div>
          <Button
            disabled={
              blocked || settingPassword || newPassword.length < PASSWORD_MIN
            }
            onClick={onSetPassword}
          >
            {settingPassword ? "Setting…" : "Set password"}
          </Button>
        </div>
      </section>

      {/* ── Plants and screens ────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-6 border-t border-line pt-4 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold text-ink">
            Plant Assignments <span className="text-ink-faint">(A-2)</span>
          </h3>
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">
            {user.role_code === "admin"
              ? "A Client Admin sees every Plant of this Client whatever is ticked; this list matters only if their role changes."
              : `${user.assigned_plants} assigned now, shown ticked. An empty list grants nothing — it is not a shortcut for "all Plants".`}
          </p>
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
            {visiblePlants.length === 0 ? (
              <p className="text-xs text-ink-faint">You have no Plants to grant.</p>
            ) : (
              visiblePlants.map((plant) => (
                <label key={plant.id} className="flex items-center gap-2 text-xs">
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
            disabled={blocked || savingPlants || !plantChange.changed}
            onClick={onSavePlants}
          >
            {savingPlants ? "Saving…" : saveLabel("Plants", plantChange)}
          </Button>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-ink">
            Dashboards <span className="text-ink-faint">(A-3)</span>
          </h3>
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">
            {user.role_code === "admin"
              ? "A Client Admin sees every screen whatever is ticked; this list matters only if their role changes."
              : "The screens this person can open, shown ticked. A screen they lack does not appear in their menu at all."}
          </p>
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-line p-2">
            {DASHBOARD_BOXES.map((box) => (
              <label key={box.codes[0]} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={box.codes.some((code) => dashboards.includes(code))}
                  onChange={(event) => toggleBox(box.codes, event.target.checked)}
                />
                {box.label}
              </label>
            ))}
          </div>
          <Button
            className="mt-2"
            disabled={blocked || savingDashboards || !dashboardChange.changed}
            onClick={onSaveDashboards}
          >
            {savingDashboards ? "Saving…" : saveLabel("screens", dashboardChange)}
          </Button>
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-4">
        <Button
          variant="danger"
          disabled={blocked || isSelf || removing}
          title={
            isSelf
              ? "You cannot remove your own membership."
              : "Removes the membership only. The User and their audit trail are kept."
          }
          onClick={onRemove}
        >
          Remove from this Client
        </Button>
      </div>
    </Panel>
  );
}
