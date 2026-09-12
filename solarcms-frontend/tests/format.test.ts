/**
 * The formatting rules are the ones most likely to produce a confidently wrong
 * number, so they are tested directly rather than through a component.
 */

import { describe, expect, it } from "vitest";
import {
  UNDEFINED_DISPLAY,
  formatCapacity,
  formatDigital,
  formatKpi,
  formatRatioAsPercent,
  formatValue,
  variantNote,
} from "@/format/value";
import { formatAge, formatDate, formatDateTime, formatTime } from "@/format/datetime";
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
