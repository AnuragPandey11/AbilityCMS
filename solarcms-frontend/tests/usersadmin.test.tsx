/**
 * The Users screen's Manage panel.
 *
 * It opens with what the person already has ticked — both lists are replaced
 * whole on save, and a panel that opened blank turned "grant one more Plant"
 * into "revoke every other one". It also changes a name, a role and a password,
 * none of which the app could do before.
 *
 * The API is mocked at the endpoint module, so what is asserted is exactly the
 * call each control makes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { User } from "@/api/schemas";

let me: {
  user_id: number;
  client_id: number | null;
  platform_admin: boolean;
  permissions: string[];
  plants: { id: number; code: string; name: string; status: string }[];
  dashboards: string[];
};

function clientAdmin(): typeof me {
  return {
    user_id: 1,
    client_id: 4,
    platform_admin: false,
    permissions: ["user.manage", "dashboard.view"],
    plants: [
      { id: 11, code: "NORTH", name: "North Mill", status: "active" },
      { id: 12, code: "SOUTH", name: "South Mill", status: "active" },
      { id: 13, code: "EAST", name: "East Mill", status: "active" },
    ],
    dashboards: [],
  };
}

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));
vi.mock("@/api/endpoints/clients", () => ({ listClients: vi.fn(async () => []) }));

const ADMIN: User = {
  id: 1, email: "asha@example.com", full_name: "Asha", is_active: true,
  last_login_at: null, role_code: "admin", assigned_plants: 0, plant_ids: [], dashboards: [],
};
const OPERATOR: User = {
  id: 2, email: "ravi@example.com", full_name: "Ravi", is_active: true,
  last_login_at: null, role_code: "employee", assigned_plants: 2,
  plant_ids: [11, 12], dashboards: ["single_plant", "alarms", "plant_list"],
};

const api = vi.hoisted(() => ({
  listUsers: vi.fn(),
  createUser: vi.fn(async () => ({})),
  updateUser: vi.fn(async () => ({})),
  setPlantAccess: vi.fn(async (_id: number, ids: number[]) => ({
    user_id: 2, requested: ids.length, granted: ids.length,
  })),
  setDashboardAccess: vi.fn(async () => ({})),
  removeUser: vi.fn(async () => undefined),
}));
vi.mock("@/api/endpoints/users", () => api);

import { UsersAdmin, describeChange } from "@/admin/UsersAdmin";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UsersAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openManage(email: string): Promise<HTMLElement> {
  const row = (await screen.findByText(email)).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Manage" }));
  const title = await screen.findByRole("heading", { name: `Manage — ${email}` });
  return title.closest("section") as HTMLElement;
}

beforeEach(() => {
  me = clientAdmin();
  api.listUsers.mockResolvedValue([ADMIN, OPERATOR]);
  for (const fn of Object.values(api)) if (fn !== api.listUsers) fn.mockClear();
});

describe("Users: the Manage panel", () => {
  it("opens with the Plants and screens the person has now ticked", async () => {
    renderScreen();
    const panel = await openManage("ravi@example.com");
    expect(within(panel).getByRole("checkbox", { name: /NORTH/ })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: /SOUTH/ })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: /EAST/ })).not.toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "Single Plant" })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "Alarms" })).toBeChecked();
    // `plant_list` alone ticks the one Plants box: the two codes are one screen.
    expect(within(panel).getByRole("checkbox", { name: "Plants" })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "Reports" })).not.toBeChecked();
  });

  it("does nothing until something changes, then says what saving will do", async () => {
    renderScreen();
    const panel = await openManage("ravi@example.com");
    expect(within(panel).getByRole("button", { name: "No changes to Plants" })).toBeDisabled();

    fireEvent.click(within(panel).getByRole("checkbox", { name: /EAST/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save Plants (add 1)" }));
    // The two it already had are kept: the save is their list plus EAST.
    await waitFor(() => expect(api.setPlantAccess).toHaveBeenCalledWith(2, [11, 12, 13]));

    fireEvent.click(within(panel).getByRole("checkbox", { name: "Alarms" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save screens (remove 1)" }));
    await waitFor(() =>
      expect(api.setDashboardAccess).toHaveBeenCalledWith(2, ["single_plant", "plant_list"]),
    );
  });

  it("changes a role and a name in one save, sending only what changed", async () => {
    renderScreen();
    const panel = await openManage("ravi@example.com");
    fireEvent.change(within(panel).getByRole("combobox", { name: /Role of ravi/ }), {
      target: { value: "admin" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save name and role" }));
    await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith(2, { role_code: "admin" }));
    expect(await screen.findByText(/is now Client Admin/)).toBeInTheDocument();
  });

  it("sets a password only once it is long enough", async () => {
    renderScreen();
    const panel = await openManage("ravi@example.com");
    const box = within(panel).getByLabelText(/New password for ravi/);
    const set = within(panel).getByRole("button", { name: "Set password" });
    fireEvent.change(box, { target: { value: "short" } });
    expect(set).toBeDisabled();
    expect(within(panel).getByText(/7 more character\(s\) needed/)).toBeInTheDocument();

    fireEvent.change(box, { target: { value: "a-long-new-password" } });
    fireEvent.click(set);
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith(2, { password: "a-long-new-password" }),
    );
  });

  it("will not let an administrator change their own role", async () => {
    renderScreen();
    const panel = await openManage("asha@example.com");
    expect(within(panel).getByRole("combobox", { name: /Role of asha/ })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Remove from this Client" })).toBeDisabled();
  });

  it("tells a platform administrator signed into no Client how to act, instead of failing", async () => {
    me = { ...clientAdmin(), client_id: null, platform_admin: true, permissions: ["system.admin", "user.manage"] };
    renderScreen();
    const panel = await openManage("ravi@example.com");
    expect(within(panel).getByText(/switch to/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("checkbox", { name: /EAST/ }));
    expect(within(panel).getByRole("button", { name: "Save Plants (add 1)" })).toBeDisabled();
  });
});

describe("describeChange", () => {
  it("counts what is added and removed, ignoring order", () => {
    expect(describeChange([1, 2], [2, 1])).toEqual({ added: 0, removed: 0, changed: false });
    expect(describeChange([1, 2], [2, 3])).toEqual({ added: 1, removed: 1, changed: true });
  });
});
