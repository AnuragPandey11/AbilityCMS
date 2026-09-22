/**
 * The formatting rules are the ones most likely to produce a confidently wrong
 * number, so they are tested directly rather than through a component.
 */

import { describe, expect, it } from "vitest";
import {
  COMPACT_ABOVE,
  UNDEFINED_DISPLAY,
  formatCapacity,
  formatDigital,
  formatHeadline,
  formatKpi,
  formatRatioAsPercent,
  formatValue,
  variantNote,
  digitsForUnit,
  formatCompact,
} from "@/format/value";
import { formatAge, formatDate, formatDateTime, formatTime,
  formatBucket,
  formatAxisLabel,
  ageSeconds,
} from "@/format/datetime";
import { isGoodQuality, quality, summariseQuality } from "@/format/quality";

describe("undefined is not zero (§4.3, Guardrail 3)", () => {
  it("renders a null KPI as a dash, not 0", () => {
    expect(formatKpi(null, "ratio")).toBe(UNDEFINED_DISPLAY);
    expect(formatKpi(null, "quantity", "kWh")).toBe(UNDEFINED_DISPLAY);
    expect(formatRatioAsPercent(null)).toBe(UNDEFINED_DISPLAY);
  });

  it("still renders a genuine zero as zero", () => {
    expect(formatKpi(0, "ratio")).toBe("0.0%");
    expect(formatValue(0, "kW")).toBe("0.00 kW");
  });

  it("treats NaN and Infinity as undefined rather than plotting them", () => {
    expect(formatValue(Number.NaN, "kW")).toBe(UNDEFINED_DISPLAY);
    expect(formatValue(Number.POSITIVE_INFINITY, "kW")).toBe(UNDEFINED_DISPLAY);
  });
});

describe("units are rendered verbatim (§4.1, Guardrail 2)", () => {
  it("does not convert kV to V, or MWh to kWh", () => {
    // The client's schedule labels an HV voltage in kV and mixes kWh with MWh
    // inside one Device. Converting here would be a silent factor-of-1000 error.
    expect(formatValue(33.2, "kV")).toBe("33.20 kV");
    expect(formatValue(12.5, "MWh")).toBe("12.50 MWh");
    expect(formatValue(1200, "kWh/m²")).toBe("1,200 kWh/m²");
  });

  it("renders a bare number when no unit is known, never a guessed one", () => {
    expect(formatValue(5, null)).toBe("5.00");
    expect(formatValue(5, undefined)).toBe("5.00");
  });

  it("states capacity units explicitly", () => {
    expect(formatCapacity(1500, "kWp")).toBe("1,500 kWp");
    expect(formatCapacity(null, "kW")).toBe(UNDEFINED_DISPLAY);
  });
});

describe("Digital Inputs are state, not numbers (§4.5)", () => {
  it("renders 0/1 as OFF/ON", () => {
    expect(formatDigital(0)).toBe("OFF");
    expect(formatDigital(1)).toBe("ON");
  });

  it("renders an absent contact as unknown, not OFF", () => {
    expect(formatDigital(null)).toBe(UNDEFINED_DISPLAY);
    expect(formatDigital(undefined)).toBe(UNDEFINED_DISPLAY);
  });
});

describe("provisional formulas are surfaced (OPEN-16)", () => {
  it("names the variant", () => {
    expect(variantNote("poa_uncorrected")).toContain("poa uncorrected");
    expect(variantNote("poa_uncorrected")).toContain("OPEN-16");
    expect(variantNote(null)).toContain("unspecified");
  });
});

describe("dates render DD-MM-YYYY HH:MM:SS in the Plant's zone (§4.4)", () => {
  // 2026-09-11T06:30:00Z is 12:00:00 on the same day in Asia/Kolkata (+05:30).
  const instant = "2026-09-11T06:30:00+00:00";

  it("uses the tender's format", () => {
    expect(formatDateTime(instant, "Asia/Kolkata")).toBe("11-09-2026 12:00:00");
    expect(formatDate(instant, "Asia/Kolkata")).toBe("11-09-2026");
    expect(formatTime(instant, "Asia/Kolkata")).toBe("12:00:00");
  });

  it("shifts with the Plant's zone rather than the browser's", () => {
    expect(formatDateTime(instant, "UTC")).toBe("11-09-2026 06:30:00");
    expect(formatDateTime(instant, "America/New_York")).toBe("11-09-2026 02:30:00");
  });

  it("renders a missing or unparseable instant as a dash", () => {
    expect(formatDateTime(null)).toBe(UNDEFINED_DISPLAY);
    expect(formatDateTime("not a date")).toBe(UNDEFINED_DISPLAY);
  });

  it("formats ages compactly", () => {
    expect(formatAge(4)).toBe("4s ago");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(7200)).toBe("2h ago");
    expect(formatAge(null)).toBe(UNDEFINED_DISPLAY);
  });
});

describe("quality codes (§4.2, Guardrail 4)", () => {
  it("treats only 0 as good", () => {
    expect(isGoodQuality(0)).toBe(true);
    for (const code of [1, 2, 3, null, undefined]) {
      expect(isGoodQuality(code)).toBe(false);
    }
  });

  it("gives each flagged code its own colour and an explanation", () => {
    expect(quality(1).label).toBe("Out of range");
    expect(quality(1).explanation).toMatch(/discarded/);
    expect(quality(3).label).toBe("Unparseable");
    expect(quality(1).color).not.toBe(quality(3).color);
  });

  it("treats an unknown code as unparseable rather than good", () => {
    expect(quality(99).code).toBe(3);
  });

  it("summarises only the non-good codes present", () => {
    expect(summariseQuality([0, 0, 0]).length).toBe(0);
    expect(summariseQuality([0, 1, 1, 3]).map((d) => d.code)).toEqual([1, 3]);
  });
});

describe("headline figures compact rather than shrink", () => {
  it("leaves an ordinary figure exactly as it was", () => {
    // The common case must be untouched: a power reading, a count, a
    // percentage. Only a figure too long for a tile is rewritten.
    const small = formatHeadline(6320.5);
    expect(small.compacted).toBe(false);
    expect(small.text).toBe(small.exact);
    // 999,999 renders in full — seven characters fits every tile, and this is
    // what keeps a lowercase `k` from ever appearing beside `kWh`.
    expect(formatHeadline(COMPACT_ABOVE - 1).compacted).toBe(false);
    expect(formatHeadline(999_999).text).toBe("999,999");
  });

  it("compacts a large figure and keeps the exact digits alongside", () => {
    const big = formatHeadline(1_241_466);
    expect(big.compacted).toBe(true);
    expect(big.text).toBe("1.24M");
    // Uppercase: a lowercase `m` beside `kWh` reads as milli.
    expect(big.text).not.toContain("m");
    // A compacted figure is a rounded one, so the exact value must survive for
    // the tooltip — an operator quoting a total needs the digits.
    expect(big.exact).toBe("1,241,466");
  });

  it("never rescales the value against a different unit (§4.1, Guardrail 2)", () => {
    // 1,241,466 kWh may be shown as "1.24M kWh". It must never become
    // "1,241.47 MWh": the unit the backend stated is the only one there is,
    // and rescaling against another is the factor-of-1000 error OPEN-15 warns
    // about. `formatHeadline` is therefore unit-blind — it takes no unit at all.
    expect(formatHeadline.length).toBe(1);
    const big = formatHeadline(1_241_466);
    expect(big.text).not.toMatch(/M?Wh|k/i);
  });

  it("keeps an undefined figure a dash, never a compacted zero", () => {
    for (const absent of [null, undefined, Number.NaN]) {
      const result = formatHeadline(absent);
      expect(result.text).toBe(UNDEFINED_DISPLAY);
      expect(result.compacted).toBe(false);
    }
  });

  it("compacts a large negative figure without losing its sign", () => {
    // Import is a real negative on a settlement meter.
    const negative = formatHeadline(-2_500_000);
    expect(negative.compacted).toBe(true);
    expect(negative.text.startsWith("-")).toBe(true);
  });
});

describe("digitsForUnit", () => {
  it("gives a count no decimals", () => {
    // A tally has no fractional part to round. The magnitude rule returned two
    // decimals below 1, so zero open Alarms rendered as "0.00" and seventeen
    // Inverters as "17.00 count" — a precision the quantity cannot have.
    expect(digitsForUnit("count")).toBe(0);
    expect(formatValue(0, "count")).toBe("0 count");
    expect(formatValue(17, "count")).toBe("17 count");
  });

  it("gives a ratio three decimals", () => {
    expect(digitsForUnit("ratio")).toBe(3);
    expect(formatValue(0.9876, "ratio")).toBe("0.988 ratio");
  });

  it("leaves every other unit to the magnitude rule", () => {
    expect(digitsForUnit("kW")).toBeUndefined();
    expect(digitsForUnit(null)).toBeUndefined();
    // A measurement keeps its decimals: 0.00 kW is a reading, not a tally.
    expect(formatValue(0, "kW")).toBe("0.00 kW");
    expect(formatValue(25609.36, "kWh")).toBe("25,609 kWh");
  });

  it("still lets a caller override", () => {
    expect(formatValue(17, "count", { digits: 2 })).toBe("17.00 count");
  });
});

describe("formatBucket", () => {
  it("renders a daily bucket as a date, with no time", () => {
    // A daily bucket shown as "17-09-2026 05:30:00" claims a reading taken at
    // half past five. It is the whole of the 17th; the 05:30 is only UTC
    // midnight expressed in the Plant's zone, and an operator reading it as a
    // time is misled by the formatter rather than by the data.
    expect(formatBucket("2026-09-17T00:00:00Z", "agg_1d", "Asia/Kolkata")).toBe("17-09-2026");
  });

  it("keeps the time on every finer tier", () => {
    for (const tier of ["readings", "agg_1m", "agg_15m", "agg_1h"]) {
      expect(formatBucket("2026-09-17T00:00:00Z", tier, "Asia/Kolkata")).toBe(
        "17-09-2026 05:30:00",
      );
    }
  });

  it("falls back to a full timestamp when the tier is unknown", () => {
    expect(formatBucket("2026-09-17T00:00:00Z", null, "Asia/Kolkata")).toBe(
      "17-09-2026 05:30:00",
    );
  });
});

describe("timestamps from a chart axis", () => {
  const EPOCH = Date.parse("2026-09-17T00:00:00Z");

  it("formats epoch milliseconds, which is what ECharts passes a tooltip", () => {
    // On a `type: "time"` axis ECharts hands the formatter `axisValue` as a
    // number. The signature said `Date | string`, so every tooltip that
    // formatted the axis value instead of the datum threw
    // `date.getTime is not a function` — inside a render, which unmounts the
    // chart. TypeScript could not catch it: the value arrives as `unknown`.
    expect(formatDateTime(EPOCH, "Asia/Kolkata")).toBe("17-09-2026 05:30:00");
    expect(formatDate(EPOCH, "Asia/Kolkata")).toBe("17-09-2026");
    expect(formatBucket(EPOCH, "agg_1d", "Asia/Kolkata")).toBe("17-09-2026");
    expect(formatAxisLabel(EPOCH, "agg_1d", "Asia/Kolkata")).toBe("17-09");
  });

  it("agrees across all three input shapes", () => {
    const iso = "2026-09-17T00:00:00Z";
    const expected = formatDateTime(iso, "Asia/Kolkata");
    expect(formatDateTime(EPOCH, "Asia/Kolkata")).toBe(expected);
    expect(formatDateTime(new Date(EPOCH), "Asia/Kolkata")).toBe(expected);
  });

  it("still returns a dash for rubbish rather than throwing", () => {
    expect(formatDateTime(Number.NaN, "Asia/Kolkata")).toBe("—");
    expect(formatDateTime("not a date", "Asia/Kolkata")).toBe("—");
    expect(ageSeconds(Number.NaN)).toBeNull();
    expect(ageSeconds(null)).toBeNull();
  });
});

describe("formatCompact", () => {
  it("uppercases the suffix, because `1.5m kWh` reads as milli", () => {
    // The same trap `formatHeadline` documents. This one feeds chart axis
    // ticks, where the suffix sits directly beside the unit name — the worst
    // possible place for a lowercase `m` next to `kWh`.
    expect(formatCompact(1_500_000)).toBe("1.5M");
    expect(formatCompact(25_000)).toBe("25K");
    expect(formatCompact(-1_368_004)).toBe("-1.4M");
  });

  it("returns a dash rather than NaN for nothing", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(Number.NaN)).toBe("—");
  });
});
