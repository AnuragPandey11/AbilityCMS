/**
 * The Data Issues screen: issues grouped by kind, fixed through the routes that
 * own each change, and marked as known without ever being hidden.
 *
 * The API is mocked at the endpoint modules, so what is asserted is exactly the
 * call each button makes — the Device, the topic, the binding and the value.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { DataIssue, PlantDataIssues } from "@/api/endpoints/dataIssues";

const me = {
  permissions: ["system.admin", "plant.manage", "config.modify", "dashboard.view"],
  plants: [{ id: 2, code: "KULAR_GREEN", name: "Kular Green Solar", status: "active" }],
  dashboards: [],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));

function issue(partial: Partial<DataIssue> & Pick<DataIssue, "key" | "kind" | "category">): DataIssue {
  return {
    title: partial.kind, detail: "Why it matters.", device_id: null, device_code: null,
    facts: {}, acknowledged: null, ...partial,
  };
}

const ATTACH = issue({
  key: "string_topic:T28", kind: "string_topic_unattached", category: "data_lost",
  device_id: 33, device_code: "INVERTER_5",
  facts: {
    topic: "SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_5_STRING28",
    owner_device_id: 33, owner_code: "INVERTER_5", keys: ["I17", "P17"], interval_s: 30,
    last_seen: "2026-10-07T12:59:00Z",
  },
});
const RENAME_A = issue({
  key: "key_renamed:38:Frequency:F", kind: "key_renamed", category: "data_lost",
  device_id: 38, device_code: "MFM",
  facts: { binding_id: 501, source_key: "Frequency", new_key: "F", tag_code: "FREQUENCY", sample: 50 },
});
const RENAME_B = issue({
  key: "key_renamed:40:AmbientTemp:AT", kind: "key_renamed", category: "data_lost",
  device_id: 40, device_code: "WMS",
  facts: { binding_id: 502, source_key: "AmbientTemp", new_key: "AT", tag_code: "AMBIENT_TEMPERATURE" },
});
const UNMAPPED_A = issue({
  key: "unmapped:40:GHI", kind: "unmapped_key", category: "data_lost", device_id: 40, device_code: "WMS",
  facts: { source_key: "GHI", sample: 512, suggested_tag_code: "GHI", suggested_taken_by: null },
});
const UNMAPPED_B = issue({
  key: "unmapped:40:GTI", kind: "unmapped_key", category: "data_lost", device_id: 40, device_code: "WMS",
  facts: { source_key: "GTI", sample: 498, suggested_tag_code: "GTI", suggested_taken_by: null },
});
const INTERVAL = issue({
  key: "interval:38", kind: "interval_slower", category: "data_wrong", device_id: 38, device_code: "MFM",
  facts: { expected_interval_s: 30, measured_interval_s: 60 },
});
const KNOWN = issue({
  key: "rejected:78:INVERTER_EFFICIENCY", kind: "values_rejected", category: "data_wrong",
  device_id: 78, device_code: "INVERTER1", title: "INVERTER1: INVERTER_EFFICIENCY values are being rejected",
  acknowledged: { id: 9, note: "raised with the client", created_at: "2026-10-07T12:00:00Z", created_by: "admin@example.com" },
});

let response: PlantDataIssues;

function baseResponse(): PlantDataIssues {
  return {
    plant_id: 2,
    generated_at: "2026-10-07T13:00:00Z",
    can_see_unregistered: true,
    counts: { data_lost: 5, data_wrong: 1, setup: 0, acknowledged: 1 },
    issues: [ATTACH, RENAME_A, RENAME_B, UNMAPPED_A, UNMAPPED_B, INTERVAL, KNOWN],
  };
}

vi.mock("@/api/hooks", () => ({
  useDataIssues: () => ({
    data: response, isLoading: false, isError: false, error: null,
    isFetching: false, refetch: vi.fn(),
  }),
  useDataIssuesSummary: () => ({ data: undefined }),
  usePlant: () => ({ data: { timezone: "Asia/Kolkata" } }),
  useDeviceModels: () => ({
    data: [
      { id: 40, model_code: "ref-inverter-string", variant: "string", device_type_code: "INVERTER", manufacturer: null },
      { id: 41, model_code: "ref-inverter-central", variant: "central", device_type_code: "INVERTER", manufacturer: null },
    ],
  }),
  useTags: () => ({
    data: [
      { id: 1, code: "GHI", name: "GHI", unit: "W/m2", category: "environmental", formula: null },
      { id: 2, code: "GTI", name: "GTI", unit: "W/m2", category: "environmental", formula: null },
    ],
  }),
}));

const devices = vi.hoisted(() => ({
  addDeviceTopic: vi.fn(async () => ({ device_id: 33, topic: "t", created: true })),
  updateBinding: vi.fn(async () => ({})),
  addBinding: vi.fn(async () => ({})),
  updateDevice: vi.fn(async () => ({})),
  createDevice: vi.fn(async () => ({ id: 90, code: "X" })),
}));
vi.mock("@/api/endpoints/devices", () => devices);

const acks = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => undefined),
  unacknowledge: vi.fn(async () => undefined),
}));
vi.mock("@/api/endpoints/dataIssues", () => acks);
vi.mock("@/api/endpoints/discovery", () => ({ ignoreTopic: vi.fn(async () => undefined) }));

import { DataIssuesAdmin } from "@/admin/dataIssues/DataIssuesAdmin";
import { bool, groupByKind, num, str, strings, topics } from "@/admin/dataIssues/kinds";

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
  response = baseResponse();
  for (const fn of [...Object.values(devices), ...Object.values(acks)]) fn.mockClear();
});

describe("Data Issues", () => {
  it("opens on data being lost, with one card per kind and the tab counts", () => {
    renderScreen();
    expect(screen.getByRole("tab", { name: /Data being lost/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Data being lost/ })).toHaveTextContent("5");
    expect(screen.getByRole("tab", { name: /Known/ })).toHaveTextContent("1");
    expect(card("String readings not attached")).toBeInTheDocument();
    expect(card("Reading renamed by the equipment")).toHaveTextContent("2");
    expect(card("Readings nobody has mapped")).toBeInTheDocument();
    // Another category's issue is not on this tab.
    expect(screen.queryByText(/Recorded every 30 s/)).not.toBeInTheDocument();
  });

  it("attaches a string topic to its Inverter", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Attach to INVERTER_5" }));
    await waitFor(() => expect(devices.addDeviceTopic).toHaveBeenCalledWith(
      33, "SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_5_STRING28", "Attached from Data Issues",
    ));
    expect(await screen.findByRole("status")).toHaveTextContent("Attached to INVERTER_5.");
  });

  it("renames every mapping in a card at once", async () => {
    renderScreen();
    fireEvent.click(within(card("Reading renamed")).getByRole("button", { name: "Rename all 2" }));
    await waitFor(() => expect(devices.updateBinding).toHaveBeenCalledTimes(2));
    expect(devices.updateBinding).toHaveBeenCalledWith(38, 501, { source_key: "F" });
    expect(devices.updateBinding).toHaveBeenCalledWith(40, 502, { source_key: "AT" });
  });

  it("maps the keys that have a suggestion", async () => {
    renderScreen();
    fireEvent.click(within(card("Readings nobody has mapped")).getByRole("button", { name: "Map the 2 suggested" }));
    await waitFor(() => expect(devices.addBinding).toHaveBeenCalledTimes(2));
    expect(devices.addBinding).toHaveBeenCalledWith(40, { source_key: "GHI", tag_code: "GHI" });
  });

  it("marks an issue as known, with why", async () => {
    renderScreen();
    const row = screen.getByText("INVERTER_5").closest("li");
    if (!row) throw new Error("no row");
    fireEvent.click(within(row).getByRole("button", { name: "Mark as known" }));
    fireEvent.change(within(row).getByLabelText("Why it is known"), { target: { value: "spare input" } });
    fireEvent.click(within(row).getByRole("button", { name: "Mark as known" }));
    await waitFor(() => expect(acks.acknowledge).toHaveBeenCalledWith(2, "string_topic:T28", "spare input"));
  });

  it("lists known issues with who and why, and undoes them", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("tab", { name: /Known/ }));
    expect(screen.getByText(/raised with the client/)).toBeInTheDocument();
    expect(screen.getByText(/admin@example.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(acks.unacknowledge).toHaveBeenCalledWith(9));
  });

  it("says a category is clear rather than showing nothing", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("tab", { name: /Setup incomplete/ }));
    expect(screen.getByText(/Setup is complete/)).toBeInTheDocument();
  });

  it("tells someone who cannot see unregistered equipment that it is not listed", () => {
    response = { ...baseResponse(), can_see_unregistered: false };
    renderScreen();
    expect(screen.getByText(/visible to the platform administrator only/)).toBeInTheDocument();
  });

  it("uses what was measured, for one Device", async () => {
    response = { ...baseResponse(), counts: { ...baseResponse().counts, data_lost: 0 },
      issues: [INTERVAL] };
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Use 60 s" }));
    await waitFor(() => expect(devices.updateDevice).toHaveBeenCalledWith(38, { expected_interval_s: 60 }));
  });
});

describe("reading facts", () => {
  it("groups by kind in the order a person deals with them", () => {
    const kinds = groupByKind([UNMAPPED_A, ATTACH, RENAME_A, UNMAPPED_B]).map((g) => g.kind);
    expect(kinds).toEqual(["string_topic_unattached", "key_renamed", "unmapped_key"]);
  });

  it("never trusts the shape of a fact", () => {
    const odd = issue({
      key: "x", kind: "unregistered_strings", category: "data_lost",
      facts: { n: "12", s: 4, b: "true", list: ["I1", 2, null], topics: [{ topic: "a/b", keys: ["I1", 3] }, "junk"] },
    });
    expect(num(odd, "n")).toBeNull();
    expect(str(odd, "s")).toBeNull();
    expect(bool(odd, "b")).toBe(false);
    expect(strings(odd, "list")).toEqual(["I1"]);
    expect(topics(odd)).toEqual([
      { topic: "a/b", device_code: "a/b", collector_code: null, interval_s: null, keys: ["I1"] },
    ]);
  });
});
