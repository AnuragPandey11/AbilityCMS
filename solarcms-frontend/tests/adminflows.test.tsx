/**
 * The two admin screens that own a noun, and the two jobs each of them does.
 *
 * Both of these regressed in the same way, twice: creating and editing were
 * folded into one screen, editing became an unlabelled side effect of clicking
 * a list row, and — worse — creating was accidentally gated on broker discovery,
 * so with the broker unreachable there was no way to add a Client at all and
 * nothing on screen said so.
 *
 * These tests run with **discovery failing**, which is the state the client's
 * firewalled broker actually puts the platform in. Everything asserted here must
 * hold in that state, because that is exactly the state in which it stopped
 * holding.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── The session: a Super Admin, one Client, one Plant ───────────────────────
const me = {
  permissions: [
    "system.admin", "plant.manage", "config.modify", "user.manage", "dashboard.view",
  ],
  plants: [{ id: 7, code: "KULAR_GREEN", name: "Kular Green Solar" }],
  dashboards: [],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));

const CLIENT = {
  id: 1,
  code: "KULAR_GREEN",
  name: "Kular Green Energy",
  status: "active",
  is_demo: false,
  created_at: "2026-01-04T00:00:00Z",
  client_number: "ACC-4471",
  gst_number: "27AAPFU0939F1ZV",
  contact_email: "accounts@kulargreen.example",
  contract_start_date: "2026-01-01",
  contract_valid_till: "2027-01-01",
};

vi.mock("@/api/endpoints/clients", () => ({
  listClients: vi.fn(async () => [CLIENT]),
  createClient: vi.fn(),
  updateClient: vi.fn(async () => ({})),
}));

// The firewalled broker, reproduced. Every discovery call fails.
vi.mock("@/api/endpoints/discovery", () => ({
  discoverClients: vi.fn(async () => { throw new Error("broker unreachable"); }),
  discoverPlants: vi.fn(async () => { throw new Error("broker unreachable"); }),
  discoverTopic: vi.fn(async () => { throw new Error("broker unreachable"); }),
}));

vi.mock("@/api/hooks", () => ({
  usePlant: () => ({
    data: {
      id: 7, code: "KULAR_GREEN", name: "Kular Green Solar", status: "active",
      ac_capacity_kw: 6000, dc_capacity_kwp: 7200, latitude: null, longitude: null,
      timezone: "Asia/Kolkata", region_code: null, grid_factor: null,
      commissioned_on: "2025-11-30", client_id: 1,
      client_code: "KULAR_GREEN", client_name: "Kular Green Energy",
    },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }),
  usePlantDevices: () => ({ data: [], isLoading: false, isError: false }),
  useDeviceModels: () => ({ data: [] }),
  useRegions: () => ({ data: [], isPending: false, isError: false }),
}));

import { ClientsAdmin } from "@/admin/ClientsAdmin";
import { PlantEditor } from "@/admin/PlantEditor";

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("Clients: adding and editing are separate, findable jobs", () => {
  it("offers both jobs by name, with editing the one you land on", () => {
    wrap(<ClientsAdmin />);
    // Named as tasks, not as a list with a button beside it.
    expect(screen.getByRole("radio", { name: /edit a client/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /add a client/i })).not.toBeChecked();
  });

  it("can start creating while the broker is unreachable", async () => {
    wrap(<ClientsAdmin />);

    fireEvent.click(screen.getByRole("radio", { name: /add a client/i }));

    // The regression: with discovery failing, the form used to be unreachable.
    expect(await screen.findByRole("heading", { name: "New Client" })).toBeInTheDocument();
    expect(screen.getByLabelText(/client code/i)).toBeEnabled();
  });

  it("asks for the whole commercial record when creating, not just a code and a name", async () => {
    wrap(<ClientsAdmin />);
    fireEvent.click(screen.getByRole("radio", { name: /add a client/i }));

    // Each of these went missing once. A field nobody can see is a field
    // nobody knows to fill in.
    for (const label of [
      /client code/i, /display name/i, /client number/i, /gst number/i,
      /contact email/i, /contract start/i, /valid for \(days\)/i,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("leaves the create form blank and editable, with no code pre-chosen for you", () => {
    wrap(<ClientsAdmin />);
    fireEvent.click(screen.getByRole("radio", { name: /add a client/i }));

    const code = screen.getByLabelText(/client code/i);
    expect(code).toHaveValue("");
    // Typed, not picked from a list of what is live: a Client is routinely
    // registered before its equipment has published anything at all.
    fireEvent.change(code, { target: { value: "NEW_SITE" } });
    expect(code).toHaveValue("NEW_SITE");
    // …and the display name follows it, so the form starts half-filled.
    expect(screen.getByLabelText(/display name/i)).toHaveValue("New Site");
  });

  it("stops filling the display name in once it has been typed over", () => {
    wrap(<ClientsAdmin />);
    fireEvent.click(screen.getByRole("radio", { name: /add a client/i }));

    const name = screen.getByLabelText(/display name/i);
    fireEvent.change(name, { target: { value: "Kular Green Energy Pvt Ltd" } });
    fireEvent.change(screen.getByLabelText(/client code/i), {
      target: { value: "KULAR_GREEN" },
    });
    // An auto-fill that overwrites what somebody just wrote is worse than none.
    expect(name).toHaveValue("Kular Green Energy Pvt Ltd");
  });

  it("shows a registered Client that is publishing nothing, and edits every field of it", async () => {
    wrap(<ClientsAdmin />);

    // Listing only *discovered* codes hid registered Clients whose broker had
    // gone quiet — and with them any way to edit one.
    const row = await screen.findByRole("button", { name: /KULAR_GREEN/ });
    expect(screen.getByText(/broker not reachable/i)).toBeInTheDocument();

    fireEvent.click(row);

    // Prefilled from the Client, so editing one field does not blank the rest.
    expect(await screen.findByLabelText(/display name/i)).toHaveValue("Kular Green Energy");
    expect(screen.getByLabelText(/client number/i)).toHaveValue("ACC-4471");
    expect(screen.getByLabelText(/gst number/i)).toHaveValue("27AAPFU0939F1ZV");
    expect(screen.getByLabelText(/contact email/i)).toHaveValue("accounts@kulargreen.example");
    expect(screen.getByLabelText(/contract start/i)).toHaveValue("2026-01-01");
    expect(screen.getByLabelText(/valid till/i)).toHaveValue("2027-01-01");
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
  });

  it("never offers the Client code as editable once it exists", async () => {
    wrap(<ClientsAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: /KULAR_GREEN/ }));

    // Guardrail 5: the code is what the topic carries. Changing it here would
    // break every Device's origin, silently and later.
    await screen.findByLabelText(/display name/i);
    expect(screen.queryByLabelText(/client code/i)).not.toBeInTheDocument();
  });
});

describe("Plants: adding and editing are separate, findable jobs", () => {
  it("offers both jobs by name, with editing the one you land on", () => {
    wrap(<PlantEditor />);
    expect(screen.getByRole("radio", { name: /edit a plant/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /add a plant/i })).not.toBeChecked();
  });

  it("keeps the create form out of the edit screen entirely", async () => {
    wrap(<PlantEditor />);

    // Editing shows the Devices of the selected Plant, and no create form.
    expect(screen.queryByRole("heading", { name: "New Plant" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /add a plant/i }));

    expect(await screen.findByRole("heading", { name: "New Plant" })).toBeInTheDocument();
    // …and creating replaces the editor rather than appearing inside it, so the
    // screen is never half-way through both jobs at once.
    expect(screen.queryByRole("button", { name: /add a device/i })).not.toBeInTheDocument();
  });

  it("asks for capacity and commissioning up front, since PR and CUF divide by them", async () => {
    wrap(<PlantEditor />);
    fireEvent.click(screen.getByRole("radio", { name: /add a plant/i }));

    for (const label of [
      /plant code/i, /display name/i, /ac capacity/i, /dc capacity/i, /commissioned on/i,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("makes every field of an existing Plant correctable, not just its name", async () => {
    wrap(<PlantEditor />);

    fireEvent.click(await screen.findByRole("button", { name: /plant details/i }));

    // Region, coordinates and the commissioning date were briefly settable once
    // and never again, which makes a typo permanent.
    await waitFor(() =>
      expect(screen.getByLabelText(/display name/i)).toHaveValue("Kular Green Solar"),
    );
    expect(screen.getByLabelText(/ac capacity/i)).toHaveValue(6000);
    expect(screen.getByLabelText(/dc capacity/i)).toHaveValue(7200);
    expect(screen.getByLabelText(/commissioned on/i)).toHaveValue("2025-11-30");
    expect(screen.getByLabelText(/latitude/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/longitude/i)).toBeInTheDocument();
  });
});
