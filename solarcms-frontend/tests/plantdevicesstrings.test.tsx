/**
 * Plants & Devices with an Inverter and its PV-string topic — the screen where
 * four Vardhman Group Inverters were registered on their string topics on
 * 12 Oct 2026, and where that is now neither offered nor a dead end:
 *
 * * a string topic whose Inverter publishes its own topic says "register the
 *   Inverter there", and registering it attaches the string topic in one click;
 * * equipment known only by its strings (ISPL's SMB1) still registers from them;
 * * an Inverter already on its string topic is moved to its own in one click;
 * * a Device registered by mistake can be removed with its Readings, after a
 *   second confirmation that says how many.
 *
 * The API is mocked at the endpoint modules, so what is asserted is each call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "@/api/problem";

const me = {
  permissions: ["system.admin", "plant.manage", "config.modify", "dashboard.view"],
  plants: [{ id: 4, code: "SPINNING_AND_GENERAL_MILLS", name: "Spinning" }],
  dashboards: [],
};
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));

const MCR = "SCMS/V1/VARDHMAN_GROUP/SPINNING_AND_GENERAL_MILLS/MCR";
const UNIT = "SCMS/V1/VARDHMAN_GROUP/SPINNING_AND_GENERAL_MILLS";

function seen(code: string, collector: string | null, extra: Record<string, unknown> = {}) {
  return {
    device_code: code, collector_code: collector,
    topic: collector ? `${MCR}/${code}` : `${UNIT}/${code}`,
    messages: 36, last_seen: new Date().toISOString(), ever_quarantined: true,
    registered_device_id: null, is_primary_topic: null, interval_s: 30, status: "live",
    string_owner_code: null, string_owner_device_id: null, ...extra,
  };
}

function registered(id: number, code: string, topic: string, extra: Record<string, unknown> = {}) {
  return {
    id, code, name: code, status: "active", block_id: null, parent_device_id: null,
    reports_via_device_id: null, collector_code: "MCR", source_address: topic,
    expected_interval_s: 30, type_code: "INVERTER", in_power_path: true,
    comm_status: "online", binding_count: 32, extra_topics: [], ...extra,
  };
}

let discovered: Record<string, unknown>[] = [];
let devicesList: Record<string, unknown>[] = [];

vi.mock("@/api/hooks", () => ({
  usePlant: () => ({
    data: {
      id: 4, code: "SPINNING_AND_GENERAL_MILLS", name: "Spinning", status: "active",
      ac_capacity_kw: 2000, dc_capacity_kwp: 2400, latitude: null, longitude: null,
      timezone: "Asia/Kolkata", region_code: null, grid_factor: null, commissioned_on: null,
      client_id: 3, client_code: "VARDHMAN_GROUP", client_name: "Vardhman Group",
    },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }),
  usePlantDevices: () => ({ data: devicesList, isLoading: false, isError: false }),
  useDeviceModels: () => ({
    data: [
      { id: 41, model_code: "ref-inverter-central", variant: "central", device_type_code: "INVERTER", manufacturer: null },
      { id: 51, model_code: "ref-smb", variant: null, device_type_code: "SMB", manufacturer: null },
    ],
  }),
  useRegions: () => ({ data: [], isPending: false, isError: false }),
}));

vi.mock("@/api/endpoints/discovery", () => ({
  discoverClients: vi.fn(async () => []),
  discoverPlants: vi.fn(async () => [{
    plant_code: "SPINNING_AND_GENERAL_MILLS", devices: discovered, collectors: ["MCR"],
    device_count: discovered.length, unregistered_count: 0, last_seen: new Date().toISOString(),
    registered_plant_id: 4,
  }]),
  discoverTopic: vi.fn(async (topic: string) => ({
    topic, seen: true, messages: 36, last_payload: null, interval_s: 30,
    keys: [
      { source_key: "PAC", sample_value: 0, suggested_tag_code: "AC_ACTIVE_POWER", unmapped: false },
      { source_key: "F", sample_value: 49, suggested_tag_code: "FREQUENCY", unmapped: false },
      { source_key: "XYZ", sample_value: 1, suggested_tag_code: null, unmapped: true },
    ],
  })),
}));

const devices = vi.hoisted(() => ({
  createDevice: vi.fn(async () => ({ id: 90, code: "INVERTER_1", bindings: { bound: 2 } })),
  addDeviceTopic: vi.fn(async () => ({ device_id: 90, topic: "t", created: true })),
  removeDeviceTopic: vi.fn(async () => undefined),
  updateDevice: vi.fn(async () => ({})),
  addBinding: vi.fn(async () => ({})),
  deleteDevice: vi.fn(async () => ({ deleted: 5, code: "MFM", readings_deleted: 224 })),
}));
vi.mock("@/api/endpoints/devices", () => devices);
vi.mock("@/api/endpoints/clients", () => ({ listClients: vi.fn(async () => []) }));

import { PlantEditor } from "@/admin/PlantEditor";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlantEditor />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The list item of the row whose code is exactly `code`. */
async function row(code: string): Promise<HTMLElement> {
  const label = await screen.findByText(code, { selector: "span.font-medium" });
  const item = label.closest("li");
  if (!item) throw new Error(`no row for ${code}`);
  return item;
}

async function open(code: string): Promise<HTMLElement> {
  const item = await row(code);
  fireEvent.click(within(item).getAllByRole("button")[0] as HTMLElement);
  return item;
}

const confirm = vi.fn<(message?: string) => boolean>(() => true);

beforeEach(() => {
  sessionStorage.clear();
  discovered = [];
  devicesList = [];
  for (const fn of Object.values(devices)) fn.mockClear();
  confirm.mockClear();
  vi.stubGlobal("confirm", confirm);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Plants & Devices: an Inverter and its string topic", () => {
  it("never offers to register an Inverter on its string topic while it has its own", async () => {
    discovered = [
      seen("INVERTER_1", "MCR"),
      seen("INVERTER_1_STRING", "MCR", { string_owner_code: "INVERTER_1" }),
    ];
    renderScreen();
    const strings = await open("INVERTER_1_STRING");
    expect(strings).toHaveTextContent("strings of INVERTER_1 — attached when INVERTER_1 is registered");
    expect(strings).toHaveTextContent("Register INVERTER_1 there and this topic is attached to it in the same step");
    expect(within(strings).queryByRole("button", { name: /^Register/ })).not.toBeInTheDocument();
  });

  it("registers the Inverter on its own topic and attaches its string topic in the same click", async () => {
    discovered = [
      seen("INVERTER_1", "MCR"),
      seen("INVERTER_1_STRING", "MCR", { string_owner_code: "INVERTER_1" }),
    ];
    renderScreen();
    const inverter = await open("INVERTER_1");
    fireEvent.change(within(inverter).getByRole("combobox"), { target: { value: "41" } });
    fireEvent.click(await within(inverter).findByRole("button", { name: "Register INVERTER_1" }));
    await waitFor(() => expect(devices.addDeviceTopic).toHaveBeenCalled());
    expect(devices.createDevice).toHaveBeenCalledWith(4, expect.objectContaining({
      code: "INVERTER_1", source_address: `${MCR}/INVERTER_1`, collector_code: "MCR",
    }));
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      90, `${MCR}/INVERTER_1_STRING`, "Attached when registered from Plants & Devices");
    expect(await screen.findByText(/and INVERTER_1_STRING attached as its string topic/)).toBeInTheDocument();
  });

  it("still registers equipment known only by its strings from them", async () => {
    // ISPL's SMB1: its own topic never publishes.
    discovered = [
      seen("SMB1_STRING16", null, { string_owner_code: "SMB1" }),
      seen("SMB1_STRING24", null, { string_owner_code: "SMB1" }),
    ];
    renderScreen();
    const strings = await open("SMB1_STRING16");
    fireEvent.change(within(strings).getByRole("combobox"), { target: { value: "51" } });
    fireEvent.click(await within(strings).findByRole("button", { name: "Register SMB1" }));
    await waitFor(() => expect(devices.addDeviceTopic).toHaveBeenCalled());
    expect(devices.createDevice).toHaveBeenCalledWith(4, expect.objectContaining({
      code: "SMB1", source_address: `${UNIT}/SMB1_STRING16`,
    }));
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      90, `${UNIT}/SMB1_STRING24`, "Attached when registered from Plants & Devices");
  });

  it("moves an Inverter registered on its string topic to its own, in one click", async () => {
    devicesList = [registered(1, "INVERTER_1", `${MCR}/INVERTER_1_STRING`)];
    discovered = [
      seen("INVERTER_1", "MCR"),
      seen("INVERTER_1_STRING", "MCR", {
        registered_device_id: 1, is_primary_topic: true, string_owner_code: "INVERTER_1",
        string_owner_device_id: 1,
      }),
    ];
    renderScreen();
    // The registered row says where it is wrong…
    const label = await screen.findByText("on its string topic — move it to its own");
    expect(label).toBeInTheDocument();
    // …and the topic it should be on offers the move.
    const own = (await screen.findByText("INVERTER_1 is registered on its string topic — data being discarded"))
      .closest("li") as HTMLElement;
    fireEvent.click(within(own).getAllByRole("button")[0] as HTMLElement);
    fireEvent.click(await within(own).findByRole("button", { name: "Move INVERTER_1 here" }));
    await waitFor(() => expect(devices.addBinding).toHaveBeenCalledTimes(2));
    expect(devices.updateDevice).toHaveBeenCalledWith(1, { source_address: `${MCR}/INVERTER_1` });
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      1, `${MCR}/INVERTER_1_STRING`, "Kept as its string topic when moved to its own topic");
    expect(devices.addBinding).toHaveBeenCalledWith(1, { source_key: "PAC", tag_code: "AC_ACTIVE_POWER" });
    expect(devices.addBinding).toHaveBeenCalledWith(1, { source_key: "F", tag_code: "FREQUENCY" });
    expect(devices.createDevice).not.toHaveBeenCalled();
  });

  it("removes a Device with its Readings only after a second confirmation naming how many", async () => {
    devicesList = [registered(5, "MFM", `${UNIT}/MFM`, { collector_code: null, type_code: "MFM" })];
    devices.deleteDevice.mockRejectedValueOnce(new ApiError({
      type: "about:blank", title: "Conflict", status: 409,
      detail: "MFM has 224 stored Reading(s). Deleting it would strand them under an id that no longer resolves.",
    }));
    renderScreen();
    const meter = await open("MFM");
    fireEvent.click(within(meter).getByRole("button", { name: "remove" }));
    await waitFor(() => expect(devices.deleteDevice).toHaveBeenCalledTimes(2));
    expect(devices.deleteDevice).toHaveBeenNthCalledWith(1, 5, false);
    expect(devices.deleteDevice).toHaveBeenNthCalledWith(2, 5, true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]?.[0]).toMatch(/224 stored Reading\(s\)[\s\S]*permanently delete those Readings/);
  });

  it("keeps the Readings when the second confirmation is declined", async () => {
    devicesList = [registered(5, "MFM", `${UNIT}/MFM`, { collector_code: null, type_code: "MFM" })];
    devices.deleteDevice.mockRejectedValueOnce(new ApiError({
      type: "about:blank", title: "Conflict", status: 409, detail: "MFM has 224 stored Reading(s).",
    }));
    confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
    renderScreen();
    const meter = await open("MFM");
    fireEvent.click(within(meter).getByRole("button", { name: "remove" }));
    expect(await screen.findByText(/MFM has 224 stored Reading/)).toBeInTheDocument();
    expect(devices.deleteDevice).toHaveBeenCalledTimes(1);
  });
});
