/**
 * The rules behind the one-big-graph trend: what shares a plot, what is
 * ticked before anyone has chosen, how tall each plot is, what colour a
 * reading wears, and what a hover says. Pure, so they are tested here and not
 * through a canvas.
 */

import { describe, expect, it } from "vitest";
import {
  ANALOG_HEIGHT_ALONE,
  ANALOG_HEIGHT_STACKED,
  LANE_BOTTOM,
  LANE_GAP,
  LANE_TOP,
  OVERLAY_HEIGHT_ALONE,
  NORMALISE_MIN_PEAK,
  OVERLAY_HEIGHT_STACKED,
  STATE_HEIGHT,
  analogValueAt,
  asPercentOfPeak,
  buildLanes,
  effectiveSelection,
  laneLayout,
  laneTitle,
  peakMagnitude,
  slotFor,
  stateAt,
  type LaneInput,
} from "@/components/charts/trendLanes";

const analog = (key: string, unit: string | null, extra: Partial<LaneInput> = {}): LaneInput => ({
  key,
  label: key.toUpperCase(),
  unit,
  kind: "analog",
  ...extra,
});
const contact = (key: string): LaneInput => ({ key, label: key, unit: "bool", kind: "state" });

describe("what is ticked", () => {
  const options = [analog("ghi", "W/m2"), analog("gti", "W/m2"), analog("wind", "m/s", { unavailableReason: "No anemometer" })];

  it("opens on the screen's defaults until the menu is touched", () => {
    expect(effectiveSelection(options, null, ["ghi", "gti"])).toEqual(new Set(["ghi", "gti"]));
  });

  it("never opens on a reading that cannot be drawn", () => {
    expect(effectiveSelection(options, null, ["wind", "gti"])).toEqual(new Set(["gti"]));
  });

  it("falls back to the first reading that can be drawn rather than opening on nothing", () => {
    expect(effectiveSelection(options, null, ["wind"])).toEqual(new Set(["ghi"]));
    expect(effectiveSelection([analog("a", "kW", { unavailableReason: "x" })], null, ["a"])).toEqual(new Set());
  });

  it("is the reader's once they have chosen — including nothing at all", () => {
    expect(effectiveSelection(options, new Set(), ["ghi"])).toEqual(new Set());
    expect(effectiveSelection(options, new Set(["gti", "wind"]), ["ghi"])).toEqual(new Set(["gti"]));
  });
});

describe("the plots", () => {
  it("puts readings of one unit on one plot and each other unit on its own", () => {
    const options = [analog("ghi", "W/m2"), analog("ambient", "degC"), analog("gti", "W/m2"), analog("module", "degC")];
    const lanes = buildLanes(options, new Set(["ghi", "gti", "ambient", "module"]));
    expect(lanes.map((lane) => lane.members)).toEqual([
      ["ghi", "gti"],
      ["ambient", "module"],
    ]);
  });

  it("groups by the catalogue unit as stored, never by what a screen prints", () => {
    // `ratio` and no unit both print as nothing, and `V` is not `kV`: one plot
    // per stored unit, or a power factor shares a scale with a status code.
    const options = [analog("pf", "ratio"), analog("code", "code"), analog("bare", null), analog("v", "V"), analog("kv", "kV")];
    const lanes = buildLanes(options, new Set(options.map((option) => option.key)));
    expect(lanes).toHaveLength(5);
  });

  it("gives every contact a plot of its own, below the measurements", () => {
    const options = [contact("trip"), analog("oil", "degC"), contact("alarm")];
    const lanes = buildLanes(options, new Set(["trip", "oil", "alarm"]));
    expect(lanes.map((lane) => [lane.kind, lane.members])).toEqual([
      ["analog", ["oil"]],
      ["state", ["trip"]],
      ["state", ["alarm"]],
    ]);
  });

  it("leaves out what is not ticked and what cannot be drawn", () => {
    const options = [analog("a", "kW"), analog("b", "kW", { unavailableReason: "none" }), analog("c", "Hz")];
    expect(buildLanes(options, new Set(["a", "b"])).map((lane) => lane.members)).toEqual([["a"]]);
  });

  it("titles a plot by its unit, or by its readings where the unit is a type name", () => {
    const options = [analog("pf_r", "ratio", { label: "PF R" }), analog("pf_y", "ratio", { label: "PF Y" }), analog("p", "kW")];
    const [pf, power] = buildLanes(options, new Set(["pf_r", "pf_y", "p"]));
    expect(laneTitle(pf!, options)).toBe("PF R · PF Y");
    expect(laneTitle(power!, options)).toBe("kW");
  });
});

describe("the geometry", () => {
  it("gives a lone plot room to be read and a stack of them a share", () => {
    const [one] = buildLanes([analog("a", "kW")], new Set(["a"])).map((lane) => lane);
    expect(laneLayout([one!]).rects[0]?.height).toBe(ANALOG_HEIGHT_ALONE);

    const stacked = buildLanes([analog("a", "kW"), analog("b", "Hz")], new Set(["a", "b"]));
    expect(laneLayout(stacked).rects.map((rect) => rect.height)).toEqual([ANALOG_HEIGHT_STACKED, ANALOG_HEIGHT_STACKED]);
  });

  it("keeps a contact's plot thin and the total the sum of the parts", () => {
    const lanes = buildLanes([analog("oil", "degC"), contact("trip")], new Set(["oil", "trip"]));
    const layout = laneLayout(lanes);
    expect(layout.rects[1]?.height).toBe(STATE_HEIGHT);
    expect(layout.rects[0]?.top).toBe(LANE_TOP);
    expect(layout.rects[1]?.top).toBe(LANE_TOP + ANALOG_HEIGHT_STACKED + LANE_GAP);
    expect(layout.total).toBe(LANE_TOP + ANALOG_HEIGHT_STACKED + LANE_GAP + STATE_HEIGHT + LANE_BOTTOM);
  });
});

describe("colour", () => {
  const options = [analog("ghi", "W/m2"), contact("trip"), analog("gti", "W/m2"), analog("wind", "m/s", { slot: 6 })];

  it("is fixed by a reading's place in the list, not by what else is ticked", () => {
    expect(slotFor(options, "ghi")).toBe(0);
    expect(slotFor(options, "gti")).toBe(1);
  });

  it("takes the screen's own slot where it gave one", () => {
    expect(slotFor(options, "wind")).toBe(6);
  });
});

describe("what a hover says", () => {
  const points = [
    { at: 0, value: 10 },
    { at: 60_000, value: null },
    { at: 120_000, value: 30 },
  ];

  it("reads the nearest bucket, a hole as null, and the far side of the data as nothing", () => {
    expect(analogValueAt(points, 5_000, 60_000)).toBe(10);
    expect(analogValueAt(points, 61_000, 60_000)).toBeNull();
    expect(analogValueAt(points, 119_000, 60_000)).toBe(30);
    // Hours past the last bucket is the rest of the day, not a reading.
    expect(analogValueAt(points, 4 * 3_600_000, 60_000)).toBeUndefined();
    expect(analogValueAt([], 0, 60_000)).toBeUndefined();
  });

  it("holds a contact's state until it changes, and not through a silence", () => {
    const steps = [
      { at: 0, state: 0 as const },
      { at: 60_000, state: 1 as const },
      { at: 180_000, state: null },
      { at: 600_000, state: 0 as const },
    ];
    expect(stateAt(steps, 30_000, 120_000)).toBe(0);
    expect(stateAt(steps, 100_000, 120_000)).toBe(1);
    expect(stateAt(steps, 200_000, 120_000)).toBeNull();
    // Before the first reading, nothing is known.
    expect(stateAt(steps, -1, 120_000)).toBeUndefined();
    // Past the last reading by more than a cycle, the step is not held.
    expect(stateAt(steps, 600_000 + 30_000, 120_000)).toBe(0);
    expect(stateAt(steps, 600_000 + 3_600_000, 120_000)).toBeUndefined();
  });
});

describe("the overlaid layout", () => {
  const options = [analog("ghi", "W/m2"), analog("ambient", "degC"), analog("gti", "W/m2"), contact("trip")];
  const everything = new Set(options.map((option) => option.key));

  it("puts every measurement on one plot, a scale per unit in order of first appearance", () => {
    const lanes = buildLanes(options, everything, "overlay");
    expect(lanes.map((lane) => lane.kind)).toEqual(["analog", "state"]);
    expect(lanes[0]?.members).toEqual(["ghi", "ambient", "gti"]);
    expect(lanes[0]?.axes).toEqual([
      { unit: "W/m2", members: ["ghi", "gti"] },
      { unit: "degC", members: ["ambient"] },
    ]);
  });

  it("still groups by the stored unit, so a ratio and a bare number do not share a scale", () => {
    const mixed = [analog("pf", "ratio"), analog("n", null)];
    expect(buildLanes(mixed, new Set(["pf", "n"]), "overlay")[0]?.axes).toHaveLength(2);
  });

  it("leaves a single unit as the plain plot, titled by its unit", () => {
    const [only] = buildLanes([analog("a", "kW"), analog("b", "kW")], new Set(["a", "b"]), "overlay");
    expect(only?.axes).toHaveLength(1);
    expect(laneTitle(only!, [analog("a", "kW"), analog("b", "kW")])).toBe("kW");
  });

  it("says each unit has its own scale, and gives the shared plot more room than a stacked one", () => {
    const [overlay] = buildLanes(options, everything, "overlay");
    expect(laneTitle(overlay!, options)).toBe("Each unit on its own scale");
    const layout = laneLayout(buildLanes(options, everything, "overlay"));
    expect(layout.rects[0]?.height).toBe(OVERLAY_HEIGHT_STACKED);
    expect(laneLayout(buildLanes([analog("a", "kW"), analog("b", "Hz")], new Set(["a", "b"]), "overlay")).rects[0]?.height).toBe(
      OVERLAY_HEIGHT_ALONE,
    );
  });

  it("is the default of nothing: stacked remains one plot per unit", () => {
    expect(buildLanes(options, everything)).toHaveLength(3);
  });
});

describe("the compare-shapes layout", () => {
  const options = [analog("ghi", "W/m2"), analog("ambient", "degC"), analog("wind", "m/s"), contact("trip")];
  const everything = new Set(options.map((option) => option.key));

  it("puts every measurement on one plot with a single scale, whatever the units", () => {
    const lanes = buildLanes(options, everything, "shapes");
    expect(lanes.map((lane) => lane.kind)).toEqual(["analog", "state"]);
    expect(lanes[0]?.members).toEqual(["ghi", "ambient", "wind"]);
    expect(lanes[0]?.normalised).toBe(true);
    // One scale, not one per unit: nothing to read a different ruler from.
    expect(lanes[0]?.axes).toBeUndefined();
  });

  it("says what the scale is", () => {
    const [shapes] = buildLanes(options, everything, "shapes");
    expect(laneTitle(shapes!, options)).toBe("Each reading as % of its own peak");
  });

  it("gives the shared plot the room the overlay has", () => {
    const [shapes] = buildLanes(options, new Set(["ghi", "ambient"]), "shapes");
    expect(laneLayout([shapes!]).rects[0]?.height).toBe(OVERLAY_HEIGHT_ALONE);
  });
});

describe("rescaling a reading to its own peak", () => {
  it("makes the reading's largest value 100% and keeps the rest in proportion", () => {
    const peak = peakMagnitude([0, 200, 400, null, 100])!;
    expect(peak).toBe(400);
    expect([0, 200, 400, 100].map((value) => asPercentOfPeak(value, peak))).toEqual([0, 50, 100, 25]);
  });

  it("keeps a gap a gap", () => {
    expect(asPercentOfPeak(null, 400)).toBeNull();
  });

  it("measures the peak by magnitude, so an import below zero still has a shape", () => {
    expect(peakMagnitude([-5, -2, 1])).toBe(5);
    expect(asPercentOfPeak(-5, 5)).toBe(-100);
  });

  it("has no peak for a reading that is flat at zero, has no readings, or is float noise", () => {
    expect(peakMagnitude([0, 0, 0])).toBeNull();
    expect(peakMagnitude([null, null])).toBeNull();
    expect(peakMagnitude([])).toBeNull();
    // A meter sending 1.5E-17 for zero must not be blown up into a full-height shape.
    expect(peakMagnitude([1.5e-17, 0, 2e-17])).toBeNull();
    expect(NORMALISE_MIN_PEAK).toBeGreaterThan(1e-17);
  });
});

