/**
 * A refused reading is shown as what arrived, marked, and never as a reading.
 *
 * UNIT1, 22 Oct 2026: the Inverter sends an efficiency of −1 for "not
 * available". It reached the screens as "−1.00 %", unmarked, and the DC Power
 * calculated from it as −49,410 kW. A blank instead would hide the evidence;
 * what an operator needs is the value that arrived, the key it came under and
 * the range it failed, to tell the equipment's fault from a mapping's.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReadingPoint, ResolvedSlot } from "@/api/schemas";
import { latestByDevice } from "@/api/useLatestValues";
import { currentValues, type DeviceLiveState } from "@/live/LiveSocket";
import { rejectedText, rejectedValue } from "@/format/rejected";
import { formatValue } from "@/format/value";
import {
  Provenance,
  isRejectedBlank,
  slotText,
  undefinedExplanation,
} from "@/components/dashboard/SlotValue";

const point = (tag: number, value: number | null, quality: number | null, minute: number): ReadingPoint => ({
  bucket: `2026-10-22T05:${String(minute).padStart(2, "0")}:00Z`,
  device_id: 81,
  tag_id: tag,
  tag_code: `T${tag}`,
  value,
  quality: quality as ReadingPoint["quality"],
});

describe("the latest stored point decides", () => {
  it("leaves no value where the latest was refused, whatever came before", () => {
    const { values, rejected } = latestByDevice(
      [point(2, 98.5, 0, 0), point(2, -1, 1, 1)],
      new Set(),
    );
    expect(values[81]["2"]).toBeUndefined();
    expect(rejected[81]["2"]).toEqual({ value: -1, quality: 1 });
  });

  it("takes an accepted value back once one arrives", () => {
    const { values, rejected } = latestByDevice(
      [point(2, -1, 1, 0), point(2, 98.5, 0, 1)],
      new Set(),
    );
    expect(values[81]["2"]).toBe(98.5);
    expect(rejected[81]["2"]).toBeUndefined();
  });

  it("does not report an unreadable value as having arrived as 0", () => {
    const { rejected } = latestByDevice([point(2, 0, 3, 0)], new Set());
    expect(rejected[81]["2"]).toEqual({ value: null, quality: 3 });
  });

  it("still shows a status code that is only outside its assumed range", () => {
    const { values } = latestByDevice([point(7, 40960, 1, 0)], new Set([7]));
    expect(values[81]["7"]).toBe(40960);
  });
});

describe("a live frame's withdrawals", () => {
  const live = (withdrawn: DeviceLiveState["withdrawn"], values: Record<number, number> = {}): DeviceLiveState => ({
    deviceId: 81, plantId: 5, values, withdrawn, at: "2026-10-22T05:30:00Z",
  });

  it("take a stored value away", () => {
    const current = currentValues({ "2": 98.5, "1": 498.8 }, live({ 2: { value: -1, quality: 1 } }));
    expect(current).toEqual({ "1": 498.8 });
  });

  it("and so does a calculation that could not be worked out", () => {
    expect(currentValues({ "3": 4200 }, live({ 3: null }))).toEqual({});
  });

  it("never outrank a value the same frame state accepted", () => {
    expect(currentValues({ "2": 98.5 }, live({}, { 2: 98.6 }))).toEqual({ "2": 98.6 });
  });
});

describe("what a rejected value says", () => {
  it("names the Device, the Tag, the key, what arrived and the range", () => {
    const text = rejectedText(
      { value: -1, quality: 1, source_key: "EFF", valid_min: 0, valid_max: 100,
        device_code: "INVERTER1", tag_code: "INVERTER_EFFICIENCY" },
      "%",
    );
    expect(text).toBe(
      `INVERTER1 sent INVERTER_EFFICIENCY (key EFF) = ${formatValue(-1, "%")}; allowed 0 to 100 %. ` +
        "Stored and flagged; not used in any figure.",
    );
  });

  it("names the refused input of a calculation instead", () => {
    const entry = { value: null, because: "INVERTER_EFFICIENCY", device_code: "INVERTER1",
                    tag_code: "DC_POWER" };
    expect(rejectedValue(entry, "kW")).toBe("not calculated");
    expect(rejectedText(entry, "kW")).toMatch(/^Not calculated: INVERTER_EFFICIENCY on INVERTER1 was rejected/);
  });

  it("says empty for a value that was not a number", () => {
    expect(rejectedValue({ value: null, quality: 3 }, "ratio")).toBe("empty");
  });
});

const slot = (over: Partial<ResolvedSlot>): ResolvedSlot => ({
  slot_code: "sld.inv.efficiency",
  label: "Efficiency",
  position: 3,
  value: null,
  unit: "%",
  undefined_reason: "no_value",
  source: {
    kind: "device_tag", device_type_code: "INVERTER", tag_code: "INVERTER_EFFICIENCY",
    aggregate: "avg", device_count: 0, is_aggregated: false, degraded: false,
  },
  ...over,
});

const efficiency = {
  device_id: 81, device_code: "INVERTER1", tag_code: "INVERTER_EFFICIENCY",
  value: -1, quality: 1, source_key: "EFF", valid_min: 0, valid_max: 100,
};

describe("a slot whose readings were refused", () => {
  it("shows what arrived, marked, in place of a dash", () => {
    const refused = slot({ rejected: [efficiency] });
    expect(isRejectedBlank(refused)).toBe(true);
    expect(slotText(refused)).toBe(`${formatValue(-1, "%")} rejected`);
    expect(undefinedExplanation(refused)).toMatch(/^Rejected — INVERTER1 sent INVERTER_EFFICIENCY \(key EFF\)/);
  });

  it("is still a quiet source when nothing was refused", () => {
    const quiet = slot({});
    expect(isRejectedBlank(quiet)).toBe(false);
    expect(slotText(quiet)).toBe("—");
  });

  it("with a value, says how many Devices it left out", () => {
    render(
      <Provenance
        slot={slot({
          value: 98.6,
          source: {
            kind: "device_tag", device_type_code: "INVERTER", tag_code: "INVERTER_EFFICIENCY",
            aggregate: "avg", device_count: 16, is_aggregated: true, degraded: false,
          },
          rejected: [efficiency],
        })}
      />,
    );
    expect(screen.getByText(/· 1 rejected/)).toBeInTheDocument();
  });
});
