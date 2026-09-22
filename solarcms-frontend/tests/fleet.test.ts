/**
 * Fleet arithmetic, and the Plants that cannot answer.
 *
 * Every case here is one that produced a wrong number on screen rather than an
 * error: a fleet average is always plausible, which is exactly what makes a
 * bad one dangerous.
 */

import { describe, expect, it } from "vitest";
import {
  couldAnswer,
  fleetTotal,
  instrumentedSplit,
  weightedRatio,
} from "@/dashboards/fleet/aggregate";
import type { KpiCoverage, KpiFigure } from "@/api/schemas";

const figure = (value: number | null): KpiFigure => ({
  value,
  variant: "time_based_excluding_comms",
  undefined_reason: value === null ? "no irradiation in period" : null,
});

const coverage = (expected: number, ratio: number | null = 1): KpiCoverage => ({
  ratio,
  complete: ratio === 1,
  expected_samples: expected,
  received_samples: expected,
  missing_seconds: 0,
  excluded_seconds: 0,
});

describe("couldAnswer", () => {
  it("excludes a Plant that expected nothing", () => {
    // A Plant with no Devices. Nothing was due, so nothing is missing — and
    // nothing can be concluded from it either.
    expect(couldAnswer(coverage(0, null))).toBe(false);
  });

  it("keeps a Plant that expected readings and received none", () => {
    // A real and terrible zero. This one must keep its vote: it is the case
    // the fleet figure exists to reveal.
    expect(couldAnswer(coverage(1000, 0))).toBe(true);
  });

  it("keeps a Plant whose API did not report coverage", () => {
    // An older backend. Silently changing what the fleet number means is worse
    // than leaving it unimproved.
    expect(couldAnswer(null)).toBe(true);
    expect(couldAnswer(undefined)).toBe(true);
  });
});

describe("weightedRatio", () => {
  it("does not let an uncommissioned Plant drag the fleet down", () => {
    // The bug, exactly: one healthy 5.6 MW Plant at 100% availability and two
    // Plants with no Devices answering `availability: 0.0` — a real number, not
    // a null — reported 52.6% fleet availability. Nothing was down; nothing was
    // even connected.
    const result = weightedRatio([
      { figure: figure(1), weight: 5600, coverage: coverage(314670, 0.15) },
      { figure: figure(0), weight: 1850, coverage: coverage(0, null) },
      { figure: figure(0), weight: 3200, coverage: coverage(0, null) },
    ]);
    expect(result.value).toBe(1);
  });

  it("weights by capacity, not by Plant count", () => {
    // A 200 MW Plant and a 2 MW Plant do not contribute equally.
    const result = weightedRatio([
      { figure: figure(1), weight: 200_000, coverage: coverage(10) },
      { figure: figure(0), weight: 2_000, coverage: coverage(10) },
    ]);
    expect(result.value).toBeCloseTo(200_000 / 202_000, 6);
  });

  it("excludes an undefined figure from both sides of the fraction", () => {
    // PR is undefined at night. Counting it as zero would halve the fleet
    // figure every evening.
    const result = weightedRatio([
      { figure: figure(0.8), weight: 1000, coverage: coverage(10) },
      { figure: figure(null), weight: 1000, coverage: coverage(10) },
    ]);
    expect(result.value).toBeCloseTo(0.8, 6);
  });

  it("says why when nothing could answer, naming the uninstrumented Plants", () => {
    const result = weightedRatio([
      { figure: figure(0), weight: 1850, coverage: coverage(0, null) },
      { figure: figure(0), weight: 3200, coverage: coverage(0, null) },
    ]);
    expect(result.value).toBeNull();
    expect(result.undefined_reason).toContain("2 Plant(s) have no Devices bound");
  });

  it("returns null rather than 0 for an empty fleet", () => {
    expect(weightedRatio([]).value).toBeNull();
  });

  it("ignores a Plant with no capacity to weight by", () => {
    const result = weightedRatio([{ figure: figure(0.9), weight: 0, coverage: coverage(10) }]);
    expect(result.value).toBeNull();
  });
});

describe("fleetTotal", () => {
  it("sums a quantity, counting an uncommissioned Plant's zero", () => {
    // The asymmetry with `weightedRatio` is deliberate: zero energy from an
    // uncommissioned Plant is arithmetically right for a *total* and nonsense
    // for a *mean*.
    expect(fleetTotal([25_609, 0, 0])).toBe(25_609);
  });

  it("skips nulls and non-finite values rather than producing NaN", () => {
    expect(fleetTotal([1, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 2])).toBe(3);
  });

  it("is 0 for an empty fleet, which is a true total", () => {
    expect(fleetTotal([])).toBe(0);
  });
});

describe("instrumentedSplit", () => {
  it("counts what is instrumented, what is not, and what has not loaded", () => {
    const split = instrumentedSplit([
      { coverage: coverage(10) } as never,
      { coverage: coverage(0, null) } as never,
      undefined,
    ]);
    expect(split).toEqual({ instrumented: 1, notInstrumented: 1, pending: 1 });
  });
});
