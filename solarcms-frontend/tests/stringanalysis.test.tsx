/**
 * String Analysis — the heatmap arranges verdicts the server made, and the
 * header never counts a zero nobody measured.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlantStringsSchema, type PlantStrings, type StringCounts } from "@/api/schemas";
import {
  Heatmap,
  InverterSwitcher,
  barFraction,
  byCode,
  stringSummary,
} from "@/dashboards/StringAnalysisDashboard";

const counts = (over: Partial<StringCounts> = {}): StringCounts => ({
  normal: 0,
  low: 0,
  no_current: 0,
  idle: 0,
  no_reading: 0,
  ...over,
});

const body = {
  plant_id: 1,
  as_of: "2026-09-30T06:30:00Z",
  units: { current: "A", voltage: "V", power: "kW" },
  rule: {
    measure: "PVn_CURRENT",
    low_below_median_fraction: "0.2",
    min_median: 2,
    lookback_minutes: 30,
    status: "PROPOSED",
  },
  counts: { normal: 1, low: 1, no_current: 1, idle: 0, no_reading: 1 },
  inverters: [
    {
      device_id: 10,
      code: "INV_10",
      name: "Inverter 10",
      variant: "string",
      comm_status: "online",
      string_count: 4,
      undefined_reason: null,
      operating: { state: "running", undefined_reason: null },
      median_current: "8.0",
      counts: { normal: 1, low: 1, no_current: 1, idle: 0, no_reading: 1 },
      strings: [
        { n: 1, state: "normal", reason: "ok", current: 8, voltage: 610, power: 4.9, at: "2026-09-30T06:29:00Z", flagged: 0 },
        { n: 2, state: "low", reason: "25% below", current: "6.0", voltage: null, power: null, at: "2026-09-30T06:29:00Z", flagged: 0 },
        { n: 3, state: "no_current", reason: "dead", current: 0, voltage: null, power: null, at: "2026-09-30T06:29:00Z", flagged: 0 },
        { n: 4, state: "no_reading", reason: "PV4 current is not bound", current: null, voltage: null, power: null, at: null, flagged: 0 },
      ],
    },
    {
      device_id: 2,
      code: "INV_2",
      name: null,
      variant: null,
      comm_status: "online",
      string_count: null,
      undefined_reason: "No string count is recorded for this Inverter.",
      operating: { state: "running", undefined_reason: null },
      median_current: null,
      counts: { normal: 0, low: 0, no_current: 0, idle: 0, no_reading: 0 },
      strings: [],
    },
  ],
};

const parsed = (): PlantStrings => PlantStringsSchema.parse(body);

describe("the response", () => {
  it("parses numeric strings, and an unknown state claims nothing", () => {
    const data = PlantStringsSchema.parse({
      ...body,
      inverters: [
        {
          ...body.inverters[0],
          strings: [{ ...body.inverters[0]!.strings[0], state: "sparkling" }],
        },
      ],
    });
    expect(data.rule.low_below_median_fraction).toBe(0.2);
    expect(data.inverters[0]!.median_current).toBe(8);
    expect(data.inverters[0]!.strings[0]!.state).toBe("no_reading");
  });
});

describe("the header's verdict", () => {
  it("leads with the fault", () => {
    expect(stringSummary(counts({ no_current: 2, low: 1, normal: 9 }))).toMatchObject({
      text: "2 strings without current · 1 low",
      tone: "bad",
    });
    expect(stringSummary(counts({ low: 1, normal: 9 }))).toMatchObject({ text: "1 low string", tone: "warn" });
  });

  it("says nothing is wrong only when something was judged", () => {
    expect(stringSummary(counts({ normal: 12 })).text).toBe("No low or dead strings");
    // At night every string is idle: a "0 faulty" here would be a zero nobody measured.
    expect(stringSummary(counts({ idle: 12 })).text).toBe("Not generating — nothing to judge");
    expect(stringSummary(counts({ no_reading: 12 })).text).toBe("No string readings");
    expect(stringSummary(counts()).text).toBe("No strings recorded");
  });
});

describe("arranging", () => {
  it("orders Inverters naturally, never INV_10 before INV_2", () => {
    expect([{ code: "INV_10" }, { code: "INV_2" }].sort(byCode).map((d) => d.code)).toEqual(["INV_2", "INV_10"]);
  });

  it("draws a bar against the strongest string, and nothing for a missing value", () => {
    expect(barFraction(6, 8)).toBe(0.75);
    expect(barFraction(null, 8)).toBe(0);
    expect(barFraction(6, null)).toBe(0);
  });
});

describe("the heatmap", () => {
  const renderHeatmap = (
    canManage: boolean,
    onSelect: (deviceId: number, n: number | null) => void = () => {},
  ) =>
    render(
      <MemoryRouter>
        <Heatmap data={parsed()} selectedId={null} onSelect={onSelect} canManage={canManage} />
      </MemoryRouter>,
    );

  it("draws each string in the state the server gave it, with its reason", () => {
    renderHeatmap(false);
    expect(screen.getByTestId("cell-10-1").dataset.state).toBe("normal");
    expect(screen.getByTestId("cell-10-2").dataset.state).toBe("low");
    expect(screen.getByTestId("cell-10-3").dataset.state).toBe("no_current");
    // Never a zero: a string with no reading says which blank it is.
    const missing = screen.getByTestId("cell-10-4");
    expect(missing.dataset.state).toBe("no_reading");
    expect(missing.getAttribute("title")).toContain("not bound");
  });

  it("puts INV_2 above INV_10 and says why INV_2 has no strings", () => {
    renderHeatmap(false);
    const rows = screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid);
    expect(rows).toEqual(["row-2", "row-10"]);
    // Said once above the rows, and briefly on the row with the reason on hover.
    expect(screen.getByText(/1 of 2 Inverters have no string count recorded/)).toBeTruthy();
    const row = screen.getByTestId("no-strings-2");
    expect(row.textContent).toContain("No string count recorded.");
    expect(row.getAttribute("title")).toContain("No string count is recorded");
    expect(screen.queryByText("Record it in Tag Mapping")).toBeNull();
  });

  it("offers the fix only to someone who can make it", () => {
    renderHeatmap(true);
    // Straight to the Inverter in question, not to a picker.
    expect(screen.getByText("Record it in Tag Mapping").getAttribute("href")).toBe("/admin/bindings?device=2");
  });

  it("opens the Inverter a cell belongs to, at that string", () => {
    const picks: [number, number | null][] = [];
    renderHeatmap(false, (id, n) => {
      picks.push([id, n]);
    });
    fireEvent.click(screen.getByTestId("cell-10-3"));
    expect(picks).toEqual([[10, 3]]);
  });
});

describe("the Inverter switcher", () => {
  const ordered = () => [...parsed().inverters].sort(byCode);

  it("steps to the neighbour and stops at the ends", () => {
    const picks: number[] = [];
    render(<InverterSwitcher inverters={ordered()} selectedId={10} onSelect={(id) => picks.push(id)} />);
    expect(screen.getByTestId("inverter-switcher").textContent).toContain("2 of 2");
    fireEvent.click(screen.getByLabelText("Previous Inverter, INV_2"));
    expect(picks).toEqual([2]);
    expect((screen.getByLabelText("No next Inverter") as HTMLButtonElement).disabled).toBe(true);
  });

  it("jumps from the list, which names each Inverter's faults", () => {
    const picks: number[] = [];
    render(<InverterSwitcher inverters={ordered()} selectedId={2} onSelect={(id) => picks.push(id)} />);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["INV_2", "INV_10 — 1 no current · 1 low"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "10" } });
    expect(picks).toEqual([10]);
  });

  it("is absent when there is nothing to switch to", () => {
    render(<InverterSwitcher inverters={ordered().slice(0, 1)} selectedId={2} onSelect={() => {}} />);
    expect(screen.queryByTestId("inverter-switcher")).toBeNull();
  });
});

describe("the Model picker in Tag Mapping", () => {
  it("leads with String or Central, and says when there is neither", async () => {
    const { modelLabel } = await import("@/admin/DeviceBindingsAdmin");
    expect(modelLabel({ model_code: "ref-inverter-string", manufacturer: null, variant: "string" })).toBe(
      "String — ref-inverter-string",
    );
    expect(modelLabel({ model_code: "SG250HX", manufacturer: "Sungrow", variant: "central" })).toBe(
      "Central — Sungrow SG250HX",
    );
    // The placeholder a broker-registered Inverter gets: no kind, said plainly.
    expect(modelLabel({ model_code: "REF-INVERTER", manufacturer: "Unspecified", variant: null })).toBe(
      "Unspecified REF-INVERTER (no variant)",
    );
  });
});
