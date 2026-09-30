/**
 * The Transformer, PPC and VCB screens.
 *
 * A contact says its state as the equipment sends it, and is marked only while
 * an open Alarm names it — never red for being TRUE. An optional figure (a
 * variant's extra thermometer) appears only where the Device carries it. And
 * every Tag code the three screens name exists in the backend's catalogue, in
 * the right kind: a contact position that named a measurement, or a typo'd
 * code, would read "not bound" for ever and send somebody to Tag Mapping.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Alarm, Tag } from "@/api/schemas";
import type { Filled } from "@/components/devices/InverterView";
import { FlagTile, figureShown } from "@/dashboards/EquipmentDashboard";
import { flagState, openAlarmsByTag } from "@/dashboards/equipment/flags";
import { PPC, TRANSFORMER, VCB } from "@/dashboards/equipment/specs";
import { isDigital } from "@/format/value";

const alarm = (over: Partial<Alarm>): Alarm => ({
  id: 1,
  state: "active",
  severity: "high",
  opened_at: "2026-09-30T06:00:00Z",
  acknowledged_at: null,
  resolved_at: null,
  message: "VCB Trip",
  trigger_value: 1,
  classification: "equipment",
  escalation_level: 0,
  device_id: 29,
  plant_id: 1,
  device_code: "VCB",
  rule_code: "VCB_TRIP",
  tag_code: "VCB_TRIP_FEEDBACK",
  ...over,
});

describe("a contact's word", () => {
  const none = new Map<string, Alarm>();

  it("is the state as sent, and a dash when nothing arrived — never FALSE", () => {
    expect(flagState(1, "VCB_ON_FEEDBACK", none).word).toBe("TRUE");
    expect(flagState(0, "VCB_ON_FEEDBACK", none).word).toBe("FALSE");
    expect(flagState(null, "VCB_ON_FEEDBACK", none).word).toBe("—");
  });

  it("is neutral in either state where no open Alarm names it", () => {
    // A closed breaker and a healthy trip coil are TRUE; neither is a fault.
    expect(flagState(1, "VCB_ON_FEEDBACK", none).tone).toBe("neutral");
    expect(flagState(1, "VCB_TC_HEALTHY", none).tone).toBe("neutral");
    expect(flagState(0, "VCB_TRIP_FEEDBACK", none).tone).toBe("neutral");
  });
});

describe("a contact's colour is an open Alarm's", () => {
  it("is red while active and amber once acknowledged", () => {
    const active = openAlarmsByTag([alarm({})], 29);
    expect(flagState(1, "VCB_TRIP_FEEDBACK", active).tone).toBe("bad");
    const acked = openAlarmsByTag([alarm({ state: "acknowledged" })], 29);
    expect(flagState(1, "VCB_TRIP_FEEDBACK", acked).tone).toBe("warn");
  });

  it("follows the rule, so an is_false rule marks a FALSE", () => {
    const alarms = openAlarmsByTag([alarm({ rule_code: "VCB_TC_UNHEALTHY", tag_code: "VCB_TC_HEALTHY" })], 29);
    expect(flagState(0, "VCB_TC_HEALTHY", alarms)).toMatchObject({ word: "FALSE", tone: "bad" });
  });

  it("still marks a contact that has gone quiet, because the Alarm is still open", () => {
    const alarms = openAlarmsByTag([alarm({})], 29);
    expect(flagState(null, "VCB_TRIP_FEEDBACK", alarms)).toMatchObject({ word: "—", tone: "bad" });
  });

  it("ignores a resolved Alarm, another Device's, another Tag's and an absence Alarm", () => {
    const alarms = openAlarmsByTag(
      [
        alarm({ state: "resolved" }),
        alarm({ device_id: 63 }),
        alarm({ tag_code: "AC_FAIL" }),
        alarm({ rule_code: "COMM_LOST", tag_code: null }),
      ],
      29,
    );
    expect(flagState(1, "VCB_TRIP_FEEDBACK", alarms).tone).toBe("neutral");
    expect([...alarms.keys()]).toEqual(["AC_FAIL"]);
  });

  it("shows the Alarm that most needs seeing where two name one contact", () => {
    const alarms = openAlarmsByTag(
      [
        alarm({ id: 1, state: "acknowledged", severity: "critical" }),
        alarm({ id: 2, state: "active", severity: "medium" }),
        alarm({ id: 3, state: "active", severity: "critical", opened_at: "2026-09-30T05:00:00Z" }),
      ],
      29,
    );
    expect(alarms.get("VCB_TRIP_FEEDBACK")?.id).toBe(3);
  });
});

describe("the flag tile", () => {
  const tag = { id: 7, code: "VCB_TRIP_FEEDBACK", name: "VCB Trip Feedback", unit: "bool" } as Tag;
  const filled = (value: number | null): Filled => ({
    label: "Tripped",
    tag,
    value,
    reason: value === null ? "Nothing received in the last 30 minutes." : null,
  });

  it("names the open Alarm's severity beside the state", () => {
    const state = flagState(1, tag.code, openAlarmsByTag([alarm({ severity: "critical" })], 29));
    render(<FlagTile filled={filled(1)} state={state} timezone="Asia/Kolkata" />);
    expect(screen.getByText("TRUE")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
  });

  it("gives the reason where there is no reading", () => {
    render(<FlagTile filled={filled(null)} state={flagState(null, tag.code, new Map())} timezone={undefined} />);
    expect(screen.getByLabelText("Nothing received in the last 30 minutes.")).toBeInTheDocument();
  });
});

describe("an optional figure", () => {
  const winding2 = TRANSFORMER.figures.find((figure) => figure.codes.includes("WTI_2_TEMPERATURE"))!;
  const oil = TRANSFORMER.figures.find((figure) => figure.codes.includes("OTI_TEMPERATURE"))!;
  const empty = (label: string): Filled => ({ label, tag: undefined, value: null, reason: "not bound" });

  it("is hidden on a Device that neither reports nor is bound to it", () => {
    expect(figureShown(winding2, empty("w2"), new Set(["WTI_1_TEMPERATURE"]))).toBe(false);
    expect(figureShown(winding2, empty("w2"), null)).toBe(false);
  });

  it("is shown where bound, even before it reports, and wherever it reports", () => {
    expect(figureShown(winding2, empty("w2"), new Set(["WTI_2_TEMPERATURE"]))).toBe(true);
    expect(figureShown(winding2, { ...empty("w2"), value: 61.2 }, null)).toBe(true);
  });

  it("is never how a required figure behaves: that one keeps its dash", () => {
    expect(figureShown(oil, empty("oil"), new Set())).toBe(true);
  });
});

describe("a contact is decided by its unit, not its category", () => {
  it("does not call a setpoint a contact, though both are never throttled", () => {
    expect(isDigital({ unit: "kW" })).toBe(false);
    expect(isDigital({ unit: "code" })).toBe(false);
    expect(isDigital({ unit: "bool" })).toBe(true);
  });
});

describe("the three specs against the backend catalogue", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "solarcms-backend/src/solarcms/domain/assumptions.py"),
    "utf8",
  );
  // TAG_SPECS rows are `"CODE": TagSpec("unit", …)`; contacts are `_di("CODE")`.
  const units = new Map<string, string>();
  for (const [, code, unit] of source.matchAll(/"([A-Z0-9_]+)":\s*TagSpec\("([^"]*)"/g)) units.set(code!, unit!);
  for (const [, code] of source.matchAll(/_di\("([A-Z0-9_]+)"\)/g)) units.set(code!, "bool");

  for (const spec of [TRANSFORMER, PPC, VCB]) {
    it(`${spec.title}: every contact is a catalogued contact`, () => {
      for (const flag of spec.flags) {
        for (const code of flag.codes) expect(units.get(code), code).toBe("bool");
      }
    });

    it(`${spec.title}: every figure is a catalogued measurement`, () => {
      for (const figure of spec.figures) {
        for (const code of figure.codes) {
          expect(units.has(code), code).toBe(true);
          expect(units.get(code), code).not.toBe("bool");
        }
      }
    });
  }
});
