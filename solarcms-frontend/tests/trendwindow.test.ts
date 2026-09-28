/**
 * The history screens' windows: which tier answers them, and what a typed
 * window means.
 *
 * The tier matters because the server refuses a request over its 20,000-point
 * cap with a 422, and a window typed by hand can be any length. The wall-time
 * conversion matters because an operator abroad typing 06:00 means sunrise at
 * the Plant, not on their laptop.
 */

import { describe, expect, it } from "vitest";
import { POINT_BUDGET, customRange, tierWithin, windowRange } from "@/api/trendWindow";
import { formatAxisLabel, fromDateTimeInput, toDateTimeInput } from "@/format/datetime";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 28 Sep 2026 10:00 UTC — 15:30 in Kolkata.
const NOW = Date.UTC(2026, 8, 28, 10, 0);

const span = (days: number, endsAgoDays = 0) => ({
  from: new Date(NOW - (days + endsAgoDays) * DAY).toISOString(),
  to: new Date(NOW - endsAgoDays * DAY).toISOString(),
});

describe("tier choice", () => {
  it("answers one day of a few series at the minute tier", () => {
    expect(tierWithin(span(1), 5, NOW)).toBe("agg_1m");
  });

  it("steps coarser rather than asking for more than the server will return", () => {
    // Seventeen Inverters at one minute over a day is 24,480 points — refused.
    expect(tierWithin(span(1), 17, NOW)).toBe("agg_15m");
    for (const [days, series] of [[7, 5], [30, 5], [365, 1], [3650, 1]] as const) {
      const tier = tierWithin(span(days), series, NOW);
      const bucket = { agg_1m: 60_000, agg_15m: 900_000, agg_1h: HOUR, agg_1d: DAY, readings: 1 }[tier];
      expect(Math.floor((days * DAY) / bucket) * series).toBeLessThanOrEqual(POINT_BUDGET);
    }
  });

  it("keeps to the span each tier serves, even inside the cap", () => {
    // A week of one Device at one minute is 10,080 points — under the cap,
    // and still far more than a chart a few hundred pixels wide can use.
    expect(tierWithin(span(7), 1, NOW)).toBe("agg_15m");
    expect(tierWithin(span(30), 1, NOW)).toBe("agg_1h");
    expect(tierWithin(span(2), 1, NOW)).toBe("agg_1m");
  });

  it("never sums Devices finer than the floor it is given", () => {
    expect(tierWithin(span(1), 2, NOW, "agg_15m")).toBe("agg_15m");
  });

  it("leaves a tier that no longer holds the window's start", () => {
    // A short window fourteen months ago: the minute tier kept a year.
    expect(tierWithin(span(0.25, 420), 1, NOW)).not.toBe("agg_1m");
  });
});

describe("preset windows", () => {
  it("frames today on the Plant's day, ending now", () => {
    const range = windowRange("today", NOW, "Asia/Kolkata");
    // Kolkata's 28 Sep began at 18:30 UTC on the 27th.
    expect(range.from).toBe("2026-09-27T18:30:00.000Z");
    expect(range.to).toBe(new Date(NOW).toISOString());
    expect(range.day?.end).toBe(Date.UTC(2026, 8, 28, 18, 30));
  });

  it("frames yesterday as a whole Plant day", () => {
    const range = windowRange("yesterday", NOW, "Asia/Kolkata");
    expect(range.from).toBe("2026-09-26T18:30:00.000Z");
    expect(range.to).toBe("2026-09-27T18:30:00.000Z");
  });
});

describe("a typed window", () => {
  it("is refused when it ends before it starts", () => {
    expect(customRange(NOW - HOUR, NOW - 2 * HOUR, NOW)).toEqual({
      error: "The end must come after the start.",
    });
  });

  it("is refused when it starts in the future", () => {
    expect("error" in customRange(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe(true);
  });

  it("stops at now — there are no readings from next week", () => {
    const range = customRange(NOW - DAY, NOW + 7 * DAY, NOW);
    expect("error" in range ? null : range.to).toBe(new Date(NOW).toISOString());
  });

  it("reads typed times as the Plant's wall clock, not the browser's", () => {
    expect(fromDateTimeInput("2026-09-28T06:00", "Asia/Kolkata")).toBe(Date.UTC(2026, 8, 28, 0, 30));
    expect(fromDateTimeInput("2026-09-28T06:00", "UTC")).toBe(Date.UTC(2026, 8, 28, 6, 0));
    expect(Number.isNaN(fromDateTimeInput("", "Asia/Kolkata"))).toBe(true);
  });

  it("round-trips through the input's own format", () => {
    const instant = Date.UTC(2026, 8, 28, 0, 30);
    expect(toDateTimeInput(instant, "Asia/Kolkata")).toBe("2026-09-28T06:00");
    expect(fromDateTimeInput(toDateTimeInput(instant, "Asia/Kolkata"), "Asia/Kolkata")).toBe(instant);
  });
});

describe("a multi-day axis", () => {
  it("dates a sub-hourly label, so a week of 16:00s says which day", () => {
    const at = Date.UTC(2026, 8, 24, 10, 30); // 16:00 in Kolkata
    expect(formatAxisLabel(at, "agg_15m", "Asia/Kolkata")).toBe("16:00");
    expect(formatAxisLabel(at, "agg_15m", "Asia/Kolkata", true)).toBe("24-09 16:00");
    // Hourly and daily labels carry their date already.
    expect(formatAxisLabel(at, "agg_1h", "Asia/Kolkata", true)).toBe("24-09 16:00");
  });
});
