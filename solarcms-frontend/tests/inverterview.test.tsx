/**
 * The Inverter view's strings — the one part of it that makes a judgement.
 *
 * "No current" is only said while the Inverter is generating. At night every
 * string carries nothing, and a wall of red badges would report a fault per
 * string on equipment that is doing exactly what it should.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Tag } from "@/api/schemas";
import { StringGrid, stringState, type Filled } from "@/components/devices/InverterView";

const tag = (code: string, unit: string): Tag => ({
  id: code.length,
  code,
  name: code,
  unit,
  category: "electrical",
  rollup_method: "avg",
  scale_default: 1,
  valid_min: null,
  valid_max: null,
  min_interval_s: 60,
  is_cumulative: false,
  formula: null,
  derived_scope: null,
});

const filled = (label: string, code: string, unit: string, value: number | null): Filled => ({
  label,
  tag: tag(code, unit),
  value,
  reason: value === null ? "Nothing received in the last 30 minutes." : null,
});

const string = (n: number, current: number | null, power: number | null, generating: boolean) => ({
  n,
  current: filled("Current", `PV${n}_CURRENT`, "A", current),
  power: filled("Power", `PV${n}_ACTIVE_POWER`, "kW", power),
  voltage: filled("Voltage", `PV${n}_VOLTAGE`, "V", null),
  state: stringState(current, generating),
});

describe("string state", () => {
  it("flags a dead string only while the Inverter is generating", () => {
    expect(stringState(0, true).text).toBe("No current");
    expect(stringState(0, true).tone).toBe("bad");
    expect(stringState(0, false).text).toBe("Idle");
    expect(stringState(0, false).tone).not.toBe("bad");
  });

  it("never reads a missing value as no current", () => {
    expect(stringState(null, true).text).toBe("No reading");
    expect(stringState(null, true).tone).not.toBe("bad");
  });

  it("leaves a string carrying current unflagged", () => {
    expect(stringState(8.4, true).text).toBe("Producing");
  });
});

describe("string grid", () => {
  it("draws each string with its figures and its state", () => {
    render(
      <StringGrid
        strings={[string(1, 8.42, 5.1, true), string(2, 0, 0, true), string(3, null, null, true)]}
      />,
    );
    const first = screen.getByTestId("string-1");
    expect(within(first).getByText("String 01")).toBeInTheDocument();
    expect(within(first).getByText("8.42")).toBeInTheDocument();
    expect(within(first).getByText("Producing")).toBeInTheDocument();

    expect(within(screen.getByTestId("string-2")).getByText("No current")).toBeInTheDocument();

    // Silence is "—", never 0.00.
    const third = screen.getByTestId("string-3");
    expect(within(third).getAllByText("—")).toHaveLength(2);
    expect(within(third).getByText("No reading")).toBeInTheDocument();
  });
});
