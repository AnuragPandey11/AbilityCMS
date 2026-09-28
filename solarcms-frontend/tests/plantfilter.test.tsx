/**
 * A platform administrator's Client filter and Plant search.
 *
 * Three things must hold: the narrowing matches on Plant *and* Client, by name
 * or code; the page never shows a Plant the filter has excluded while any Plant
 * matches (nor goes blank when none does); and a search writes only once typing
 * pauses, because each write switches the Plant and fires its queries.
 */

import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, MePlant, PlantListItem } from "@/api/schemas";

const PLANTS: MePlant[] = [
  { id: 1, code: "SF_NORTH", name: "Sunfield North", status: "active" },
  { id: 2, code: "SF_SOUTH", name: "Sunfield South", status: "active" },
  { id: 3, code: "WH1", name: "Warehouse One", status: "active" },
  { id: 4, code: "WH2", name: "Warehouse Two", status: "active" },
];

function listItem(plant: MePlant, clientId: number, code: string, name: string): PlantListItem {
  return {
    ...plant,
    ac_capacity_kw: null,
    dc_capacity_kwp: null,
    region_code: null,
    device_count: 0,
    client_id: clientId,
    client_code: code,
    client_name: name,
  };
}

const ALL_PLANTS: PlantListItem[] = [
  listItem(PLANTS[0], 10, "SUNFIELD", "Sunfield Energy"),
  listItem(PLANTS[1], 10, "SUNFIELD", "Sunfield Energy"),
  listItem(PLANTS[2], 20, "ROOFCO", "Roofco Rooftops"),
  listItem(PLANTS[3], 20, "ROOFCO", "Roofco Rooftops"),
];

let me: Me;

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated" }),
}));

vi.mock("@/api/hooks", () => ({
  useAllPlants: (enabled: boolean) =>
    enabled
      ? { data: ALL_PLANTS, isSuccess: true }
      : { data: undefined, isSuccess: false },
}));

const { useSelection } = await import("@/state/selection");
const { matchPlants, usePlantFilter } = await import("@/state/usePlantFilter");
const { usePlantScope, useFilteredPlantScope } = await import("@/state/usePlantScope");
const { PlantFilterBar, PLANT_SEARCH_DEBOUNCE_MS } = await import(
  "@/components/layout/PlantFilterBar"
);

function meFor(platformAdmin: boolean): Me {
  return {
    user_id: 1,
    client_id: platformAdmin ? null : 20,
    client_code: null,
    client_name: null,
    role: platformAdmin ? "super_admin" : "admin",
    platform_admin: platformAdmin,
    permissions: [],
    plants: PLANTS,
    dashboards: [],
  };
}

beforeEach(() => {
  me = meFor(true);
  useSelection.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("matchPlants", () => {
  const clientOf = (plantId: number) => {
    const item = ALL_PLANTS.find((plant) => plant.id === plantId)!;
    return {
      id: item.client_id,
      code: item.client_code,
      name: item.client_name,
      label: item.client_name!,
      plantCount: 2,
    };
  };
  const codes = (clientId: number | null, search: string) =>
    matchPlants(PLANTS, clientOf, clientId, search).map((plant) => plant.code);

  it("narrows to one Client", () => {
    expect(codes(20, "")).toEqual(["WH1", "WH2"]);
  });

  it("searches Plant name and code, case-insensitively", () => {
    expect(codes(null, "warehouse two")).toEqual(["WH2"]);
    expect(codes(null, "sf_s")).toEqual(["SF_SOUTH"]);
  });

  it("searches Client name and code", () => {
    expect(codes(null, "rooftops")).toEqual(["WH1", "WH2"]);
    expect(codes(null, "SUNFIELD")).toEqual(["SF_NORTH", "SF_SOUTH"]);
  });

  it("requires every word, across Plant and Client together", () => {
    expect(codes(null, "roofco one")).toEqual(["WH1"]);
    expect(codes(null, "roofco north")).toEqual([]);
  });

  it("combines the Client filter with the search", () => {
    expect(codes(10, "warehouse")).toEqual([]);
  });
});

describe("usePlantFilter", () => {
  it("is off for anyone but a platform administrator", () => {
    me = meFor(false);
    useSelection.getState().setClientId(20);
    const { result } = renderHook(() => usePlantFilter());
    expect(result.current.enabled).toBe(false);
    expect(result.current.active).toBe(false);
    expect(result.current.matches).toHaveLength(4);
  });

  it("ignores a persisted Client that is no longer visible", () => {
    useSelection.getState().setClientId(99);
    const { result } = renderHook(() => usePlantFilter());
    expect(result.current.clientId).toBeNull();
    expect(result.current.matches).toHaveLength(4);
  });

  it("derives one Client per owner, with its Plant count", () => {
    const { result } = renderHook(() => usePlantFilter());
    expect(result.current.clients.map((c) => [c.code, c.plantCount])).toEqual([
      ["ROOFCO", 2],
      ["SUNFIELD", 2],
    ]);
  });
});

describe("useFilteredPlantScope()", () => {
  it("moves the selection into the chosen Client", () => {
    useSelection.getState().setPlantId(1);
    const { result } = renderHook(() => useFilteredPlantScope());
    expect(result.current.plantId).toBe(1);

    act(() => useSelection.getState().setClientId(20));
    expect(result.current.plantId).toBe(3);
    expect(result.current.plants.map((plant) => plant.code)).toEqual(["WH1", "WH2"]);
    // Written back, so the next Plant screen agrees.
    expect(useSelection.getState().plantId).toBe(3);
  });

  it("keeps the current Plant, and still names it, when nothing matches", () => {
    useSelection.getState().setPlantId(2);
    const { result } = renderHook(() => useFilteredPlantScope());
    act(() => useSelection.getState().setPlantSearch("no such plant"));
    expect(result.current.plantId).toBe(2);
    expect(result.current.plants.map((plant) => plant.code)).toEqual(["SF_SOUTH"]);
    expect(result.current.hasNoPlants).toBe(false);
  });

  it("leaves the plain usePlantScope unaffected by the filter", () => {
    useSelection.getState().setPlantId(1);
    useSelection.getState().setClientId(20);
    const { result } = renderHook(() => usePlantScope());
    expect(result.current.plantId).toBe(1);
    expect(result.current.plants).toHaveLength(4);
  });
});

describe("PlantFilterBar", () => {
  it("renders nothing for a Client user", () => {
    me = meFor(false);
    const { container } = render(<PlantFilterBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("writes the search only once typing pauses", () => {
    vi.useFakeTimers();
    render(<PlantFilterBar />);
    const input = screen.getByRole("combobox", { name: /search plants/i });

    fireEvent.change(input, { target: { value: "r" } });
    act(() => vi.advanceTimersByTime(PLANT_SEARCH_DEBOUNCE_MS - 50));
    fireEvent.change(input, { target: { value: "roofco" } });
    act(() => vi.advanceTimersByTime(PLANT_SEARCH_DEBOUNCE_MS - 50));
    expect(useSelection.getState().plantSearch).toBe("");

    act(() => vi.advanceTimersByTime(50));
    expect(useSelection.getState().plantSearch).toBe("roofco");
    expect(screen.getByText("2 of 4 Plants")).toBeInTheDocument();
  });

  it("clears at once, and a stale pending value does not come back", () => {
    vi.useFakeTimers();
    render(<PlantFilterBar />);
    const input = screen.getByRole("combobox", { name: /search plants/i });
    fireEvent.change(input, { target: { value: "roofco" } });
    act(() => vi.advanceTimersByTime(PLANT_SEARCH_DEBOUNCE_MS));
    expect(useSelection.getState().plantSearch).toBe("roofco");

    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(useSelection.getState().plantSearch).toBe("");
    act(() => vi.advanceTimersByTime(PLANT_SEARCH_DEBOUNCE_MS * 2));
    expect(useSelection.getState().plantSearch).toBe("");
    expect(input).toHaveValue("");
  });

  it("says so when nothing matches — in the list at once, on the page once typing pauses", () => {
    vi.useFakeTimers();
    render(<PlantFilterBar />);
    fireEvent.change(screen.getByRole("combobox", { name: /search plants/i }), {
      target: { value: "atlantis" },
    });
    expect(screen.getAllByText(/No Plant or Client matches “atlantis”/)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(PLANT_SEARCH_DEBOUNCE_MS));
    expect(screen.getAllByText(/No Plant or Client matches “atlantis”/)).toHaveLength(2);
  });
});

describe("PlantFilterBar suggestions", () => {
  const input = () => screen.getByRole("combobox", { name: /search plants/i });
  // Scoped to the list: the Client <select>'s own <option>s share the role.
  const suggestions = () => within(screen.getByRole("listbox")).getAllByRole("option");
  const options = () => suggestions().map((option) => option.textContent);

  beforeEach(() => {
    vi.useFakeTimers();
    useSelection.getState().setPlantId(3);
  });

  it("suggests on the first letter, and on each letter after, with no wait", () => {
    render(<PlantFilterBar />);
    fireEvent.change(input(), { target: { value: "s" } });
    // Both SUNFIELD Plants, and not the ROOFCO ones that merely contain an s.
    expect(options()).toEqual([
      expect.stringContaining("SF_NORTH"),
      expect.stringContaining("SF_SOUTH"),
    ]);
    fireEvent.change(input(), { target: { value: "so" } });
    expect(options()).toEqual([expect.stringContaining("SF_SOUTH")]);
    // The page's narrowing has not moved yet: that part waits for a pause.
    expect(useSelection.getState().plantSearch).toBe("");
  });

  it("takes the best match on Enter, typo and all, and commits at once", () => {
    render(<PlantFilterBar />);
    fireEvent.change(input(), { target: { value: "sf-norht" } });
    expect(input()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(input()).toHaveValue("SF_NORTH");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(useSelection.getState().plantSearch).toBe("SF_NORTH");
    expect(useSelection.getState().plantId).toBe(1);
  });

  it("moves through the list with the arrow keys", () => {
    render(<PlantFilterBar />);
    fireEvent.change(input(), { target: { value: "s" } });
    const [first, second] = suggestions();
    expect(input()).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", second.id);
    expect(second).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(useSelection.getState().plantId).toBe(2);
  });

  it("chooses a suggestion on click", () => {
    render(<PlantFilterBar />);
    fireEvent.change(input(), { target: { value: "warehouse" } });
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /WH2/ }));
    expect(input()).toHaveValue("WH2");
    expect(useSelection.getState().plantId).toBe(4);
  });

  it("closes on the first Escape and clears on the second", () => {
    render(<PlantFilterBar />);
    fireEvent.change(input(), { target: { value: "roofco" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("roofco");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("");
  });
});
