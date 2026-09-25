/**
 * The Inverter Monitoring card.
 *
 * What is pinned here is what the card may *say*, not how it looks:
 *
 * 1. **Load is output over the recorded rating and nothing else.** With no
 *    rating it shows no load and says why. It never estimates a rating.
 * 2. **Units are never converted.** A power Tag in MW gets no load rather than
 *    a silent factor of 1000 against a kW rating.
 * 3. **Over 100% is flagged, not filled.** A full accent meter would read as a
 *    perfect result (Guardrail 33).
 * 4. **Silence is "—", never 0**, and the meter stays empty for it.
 * 5. **The compared figure stays on the card**, so the "#n" beside the code
 *    always has its number somewhere below it.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DeviceListItemSchema,
  type DeviceListItem,
  type DeviceTableColumn,
  type Tag,
} from "@/api/schemas";
import { InverterCard, inverterCardTagIds } from "@/components/devices/InverterCard";

const column = (
  tag_id: number,
  tag_code: string,
  name: string,
  unit: string | null,
): DeviceTableColumn => ({ tag_id, tag_code, name, unit, category: "electrical", position: tag_id });

const COLUMNS: DeviceTableColumn[] = [
  column(1, "AC_ACTIVE_POWER", "AC Active Power", "kW"),
  column(2, "DC_POWER", "DC Power", "kW"),
  column(3, "INVERTER_EFFICIENCY", "Inverter Efficiency", "%"),
  column(4, "ENERGY_TODAY", "Energy Today", "kWh"),
  column(5, "DC_VOLTAGE", "DC Voltage", "V"),
  column(6, "DC_CURRENT", "DC Current", "A"),
  column(7, "DEVICE_TEMPERATURE", "Device Temperature", "degC"),
  column(8, "FREQUENCY", "Frequency", "Hz"),
];

const tag = (id: number, code: string, unit: string): Tag =>
  ({ id, code, name: code, unit, category: "performance" }) as Tag;

const TAGS = new Map<string, Tag>([
  ["ENERGY_TOTAL", tag(20, "ENERGY_TOTAL", "kWh")],
  ["ENERGY_CUMULATIVE_MWH", tag(21, "ENERGY_CUMULATIVE_MWH", "MWh")],
]);

function inverter(overrides: Partial<DeviceListItem> = {}): DeviceListItem {
  return {
    ...DeviceListItemSchema.parse({
      id: 7,
      code: "INVERTER_7",
      name: "INVERTER_7",
      status: "active",
      block_id: null,
      parent_device_id: null,
      reports_via_device_id: null,
      source_address: "scms/v1/C/P/MCR/INVERTER_7",
      expected_interval_s: 60,
      type_code: "INVERTER",
      in_power_path: true,
      variant: "string",
      comm_status: "online",
      last_seen_at: new Date().toISOString(),
      frozen_tag_count: 0,
      rated_capacity_kw: 400,
      binding_count: 18,
    }),
    ...overrides,
  };
}

function renderCard({
  device = inverter(),
  columns = COLUMNS,
  values = { "1": 200, "3": 98.5, "4": 1042 } as Record<string, number>,
  highlightTagId,
}: {
  device?: DeviceListItem;
  columns?: DeviceTableColumn[];
  values?: Record<string, number>;
  highlightTagId?: number;
} = {}) {
  const view = render(
    <InverterCard
      device={device}
      columns={columns}
      tagsByCode={TAGS}
      values={values}
      highlightTagId={highlightTagId}
      position={2}
      onSelect={() => undefined}
    />,
  );
  const segments = [...view.container.querySelectorAll("span.h-3.flex-1")];
  const filled = (hue: "accent" | "warn") =>
    segments.filter((segment) => segment.classList.contains(`bg-${hue}`)).length;
  return { ...view, segments, filled };
}

describe("InverterCard", () => {
  it("shows load as output over the recorded rating", () => {
    const { segments, filled } = renderCard();
    expect(screen.getByText("50.0% load")).toBeTruthy();
    expect(screen.getByText("Rated 400.0 kW")).toBeTruthy();
    expect(segments).toHaveLength(24);
    expect(filled("accent")).toBe(12);
    // The scale is the rating in quarters, never a guessed full-scale.
    expect(screen.getByText("400 kW")).toBeTruthy();
    expect(screen.getByText("100 kW")).toBeTruthy();
  });

  it("flags a load above the rating instead of drawing a full, healthy meter", () => {
    const { filled } = renderCard({ device: inverter({ rated_capacity_kw: 200 }), values: { "1": 210 } });
    const badge = screen.getByText("105.0% load");
    expect(badge.className).toContain("text-warn");
    expect(badge.getAttribute("title")).toMatch(/recorded capacity is wrong/);
    expect(filled("warn")).toBe(24);
    expect(filled("accent")).toBe(0);
  });

  it("shows no load, and says why, when no rating is recorded", () => {
    const { filled } = renderCard({ device: inverter({ rated_capacity_kw: null }) });
    expect(screen.queryByText(/% load/)).toBeNull();
    expect(screen.getByText("No rating recorded")).toBeTruthy();
    expect(screen.getByText("Record a rating in Tag Mapping to show load")).toBeTruthy();
    expect(filled("accent")).toBe(0);
    // The output itself is still shown: only the ratio needs the rating.
    expect(screen.getByText("200.0")).toBeTruthy();
  });

  it("never converts units to make a load", () => {
    const columns = COLUMNS.map((c) => (c.tag_id === 1 ? { ...c, unit: "MW" } : c));
    renderCard({ columns, values: { "1": 0.2 } });
    expect(screen.queryByText(/% load/)).toBeNull();
    expect(screen.getByText("Output in MW, rating in kW")).toBeTruthy();
  });

  it("renders silence as a dash with an empty meter, never zero", () => {
    const { filled } = renderCard({ values: {} });
    expect(screen.queryByText(/% load/)).toBeNull();
    expect(filled("accent")).toBe(0);
    expect(screen.queryByText("0.0")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("takes the lifetime total from whichever preferred Tag has a value", () => {
    renderCard({ values: { "1": 200, "20": 102_751 } });
    expect(screen.getByText("102,751 kWh")).toBeTruthy();
    renderCard({ values: { "1": 200, "21": 102.75 } });
    expect(screen.getByText("102.8 MWh")).toBeTruthy();
  });

  it("keeps the compared figure on the card even past the first few columns", () => {
    // FREQUENCY is the fourth remaining column, so it would normally be left off.
    renderCard({ values: { "1": 200, "8": 50.01 }, highlightTagId: 8 });
    const figure = screen.getByText("50.01 Hz");
    expect(figure.className).toContain("text-accent");
    expect(screen.queryByText("Device Temperature")).toBeNull();
  });

  it("says a Device with no bindings decodes into nothing", () => {
    renderCard({ device: inverter({ binding_count: 0 }), values: {} });
    expect(screen.getByText(/No Tags are bound/)).toBeTruthy();
  });

  it("asks for every Tag it can place, including those that are not columns", () => {
    expect(inverterCardTagIds(TAGS).sort()).toEqual([20, 21]);
  });
});
