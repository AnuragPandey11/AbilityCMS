/**
 * Data Issues for an Inverter and its PV-string topic — the two ways onboarding
 * went wrong at Vardhman Group on 12 Oct 2026, fixed in one click each:
 *
 * * an Inverter not registered yet is registered on its own topic, and its
 *   string topic is attached in the same click;
 * * an Inverter already registered on its string topic is moved to its own
 *   topic, one at a time or all together.
 *
 * The API is mocked at the endpoint modules, so what is asserted is exactly the
 * call each button makes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { DataIssue, PlantDataIssues } from "@/api/endpoints/dataIssues";

const me = {
  permissions: ["system.admin", "plant.manage", "config.modify", "dashboard.view"],
  plants: [{ id: 4, code: "SPINNING_AND_GENERAL_MILLS", name: "Spinning", status: "active" }],
  dashboards: [],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));

const MCR = "SCMS/V1/VARDHMAN_GROUP/SPINNING_AND_GENERAL_MILLS/MCR";

function issue(partial: Partial<DataIssue> & Pick<DataIssue, "key" | "kind" | "category">): DataIssue {
  return {
    title: partial.kind, detail: "Why it matters.", device_id: null, device_code: null,
    facts: {}, acknowledged: null, ...partial,
  };
}

function misplaced(id: number, code: string): DataIssue {
  return issue({
    key: `on_string_topic:${id}`, kind: "registered_on_string_topic", category: "data_lost",
    device_id: id, device_code: code,
    facts: {
      topic: `${MCR}/${code}`, string_topic: `${MCR}/${code}_STRING`, collector_code: "MCR",
      messages: 4, last_seen: "2026-10-12T17:20:00Z", keys: ["PAC", "F", "XYZ"],
      suggested_bindings: [
        { source_key: "F", tag_code: "FREQUENCY" },
        { source_key: "PAC", tag_code: "AC_ACTIVE_POWER" },
      ],
      unsuggested_keys: ["XYZ"],
    },
  });
}

const UNREGISTERED = issue({
  key: `unregistered:${MCR}/INVERTER_3`, kind: "unregistered_topic", category: "data_lost",
  device_code: "INVERTER_3",
  facts: {
    topic: `${MCR}/INVERTER_3`, device_code: "INVERTER_3", collector_code: "MCR",
    interval_s: 30, last_seen: "2026-10-12T17:20:00Z", messages: 40, keys: ["PAC", "F"],
    suggested_type: "INVERTER", code_taken: false,
    string_topics: [{
      topic: `${MCR}/INVERTER_3_STRING`, device_code: "INVERTER_3_STRING", collector_code: "MCR",
      interval_s: 30, keys: ["I1", "P1"],
    }],
  },
});

let response: PlantDataIssues;

vi.mock("@/api/hooks", () => ({
  useDataIssues: () => ({
    data: response, isLoading: false, isError: false, error: null,
    isFetching: false, refetch: vi.fn(),
  }),
  useDataIssuesSummary: () => ({ data: undefined }),
  usePlant: () => ({ data: { timezone: "Asia/Kolkata" } }),
  useDeviceModels: () => ({
    data: [
      { id: 41, model_code: "ref-inverter-central", variant: "central", device_type_code: "INVERTER", manufacturer: null },
    ],
  }),
  useTags: () => ({ data: [] }),
}));

const devices = vi.hoisted(() => ({
  addDeviceTopic: vi.fn(async () => ({ device_id: 90, topic: "t", created: true })),
  updateBinding: vi.fn(async () => ({})),
  addBinding: vi.fn(async () => ({})),
  updateDevice: vi.fn(async () => ({})),
  createDevice: vi.fn(async () => ({ id: 90, code: "INVERTER_3" })),
}));
vi.mock("@/api/endpoints/devices", () => devices);
vi.mock("@/api/endpoints/dataIssues", () => ({
  acknowledge: vi.fn(async () => undefined),
  unacknowledge: vi.fn(async () => undefined),
}));
vi.mock("@/api/endpoints/discovery", () => ({ ignoreTopic: vi.fn(async () => undefined) }));

import { DataIssuesAdmin } from "@/admin/dataIssues/DataIssuesAdmin";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DataIssuesAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function card(heading: string): HTMLElement {
  const title = screen.getByRole("heading", { name: new RegExp(heading) });
  const section = title.closest("section");
  if (!section) throw new Error(`no card for ${heading}`);
  return section;
}

beforeEach(() => {
  response = {
    plant_id: 4,
    generated_at: "2026-10-12T17:21:00Z",
    can_see_unregistered: true,
    counts: { data_lost: 3, data_wrong: 0, setup: 0, acknowledged: 0 },
    issues: [misplaced(1, "INVERTER_1"), misplaced(2, "INVERTER_2"), UNREGISTERED],
  };
  for (const fn of Object.values(devices)) fn.mockClear();
});

describe("Data Issues: an Inverter and its string topic", () => {
  it("names an Inverter registered on its string topic, and where its readings go", () => {
    renderScreen();
    const moves = card("Inverter registered on its string topic");
    expect(moves).toHaveTextContent(`registered on ${MCR}/INVERTER_1_STRING`);
    expect(within(moves).getByRole("button", { name: "Move all 2" })).toBeInTheDocument();
  });

  it("moves one Inverter to its own topic, keeping its strings and mapping its readings", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Move INVERTER_1 to its own topic" }));
    await waitFor(() => expect(devices.addBinding).toHaveBeenCalledTimes(2));
    expect(devices.updateDevice).toHaveBeenCalledWith(1, { source_address: `${MCR}/INVERTER_1` });
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      1, `${MCR}/INVERTER_1_STRING`, "Kept as its string topic when moved to its own topic");
    expect(devices.addBinding).toHaveBeenCalledWith(1, { source_key: "PAC", tag_code: "AC_ACTIVE_POWER" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "INVERTER_1 moved to its own topic, with its string topic still attached, and 2 reading(s) mapped.");
  });

  it("moves every Inverter in the card at once", async () => {
    renderScreen();
    fireEvent.click(within(card("Inverter registered on its string topic")).getByRole("button", { name: "Move all 2" }));
    await waitFor(() => expect(devices.updateDevice).toHaveBeenCalledTimes(2));
    expect(devices.updateDevice).toHaveBeenCalledWith(2, { source_address: `${MCR}/INVERTER_2` });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "2 moved to their own topics, string topics still attached, and 4 reading(s) mapped.");
  });

  it("registers an Inverter on its own topic and attaches its string topic in the same click", async () => {
    renderScreen();
    const register = card("Sending data but not registered");
    expect(register).toHaveTextContent("its strings arrive on INVERTER_3_STRING");
    fireEvent.click(within(register).getByRole("button", { name: "Register INVERTER_3" }));
    await waitFor(() => expect(devices.addDeviceTopic).toHaveBeenCalled());
    expect(devices.createDevice).toHaveBeenCalledWith(4, expect.objectContaining({
      code: "INVERTER_3", source_address: `${MCR}/INVERTER_3`, collector_code: "MCR",
    }));
    expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      90, `${MCR}/INVERTER_3_STRING`, "Attached when registered from Data Issues");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "INVERTER_3 registered, with INVERTER_3_STRING attached.");
  });
});
