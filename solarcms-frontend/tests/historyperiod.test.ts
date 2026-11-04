/**
 * The history screens' shared period (`api/historyPeriod`): calendar
 * arithmetic, the link, and the words. Calendar arithmetic is where periods go
 * wrong — a month back from 31 March, a year back from 29 February, a day 23
 * hours long — so each case is pinned here rather than trusted.
 */

import { describe, expect, it } from "vitest";
import {
  canonical,
  comparisonPeriod,
  daysPeriod,
  detailNote,
  nominalBounds,
  periodDates,
  periodFromParams,
  periodLabel,
  periodToParams,
  resolvePeriod,
  samePeriod,
  shiftPeriod,
  type HistoryPeriod,
} from "@/api/historyPeriod";

const KOLKATA = "Asia/Kolkata";
// 15:30 on 5 Nov 2026 in Kolkata (UTC+5:30).
const NOW = Date.UTC(2026, 10, 5, 10, 0);
const preset = (name: Extract<HistoryPeriod, { kind: "preset" }>["preset"]): HistoryPeriod => ({
  kind: "preset",
  preset: name,
});
const custom = (from: string, to: string): HistoryPeriod => ({ kind: "custom", from, to });

function resolved(period: HistoryPeriod, now = NOW, zone = KOLKATA) {
  const out = resolvePeriod(period, now, zone);
  if ("error" in out) throw new Error(out.error);
  return out;
}

describe("resolving a period on the Plant's clock", () => {
  it("frames today from the Plant's midnight, ends at now, and runs the axis to 24:00", () => {
    const today = resolved(preset("today"));
    expect(today.from).toBe("2026-11-04T18:30:00.000Z");
    expect(today.to).toBe(new Date(NOW).toISOString());
    expect(today.day).toEqual({ start: Date.parse("2026-11-04T18:30:00Z"), end: Date.parse("2026-11-05T18:30:00Z") });
    expect(today.live).toBe(true);
  });

  it("takes yesterday whole, and is not live", () => {
    const yesterday = resolved(preset("yesterday"));
    expect(yesterday.from).toBe("2026-11-03T18:30:00.000Z");
    expect(yesterday.to).toBe("2026-11-04T18:30:00.000Z");
    expect(yesterday.live).toBe(false);
  });

  it("starts this month on the 1st at the Plant's midnight, and last month ends there", () => {
    expect(resolved(preset("this_month")).from).toBe("2026-10-31T18:30:00.000Z");
    const last = resolved(preset("last_month"));
    expect(last.from).toBe("2026-09-30T18:30:00.000Z");
    expect(last.to).toBe("2026-10-31T18:30:00.000Z");
    expect(last.day).toBeNull();
  });

  it("starts this year on 1 January, last year runs January to January", () => {
    expect(resolved(preset("this_year")).from).toBe("2025-12-31T18:30:00.000Z");
    const last = resolved(preset("last_year"));
    expect(last.from).toBe("2024-12-31T18:30:00.000Z");
    expect(last.to).toBe("2025-12-31T18:30:00.000Z");
  });

  it("keeps the rolling windows rolling: thirty days back from now", () => {
    const thirty = resolved(preset("30d"));
    expect(Date.parse(thirty.to) - Date.parse(thirty.from)).toBe(30 * 86_400_000);
    expect(thirty.live).toBe(true);
  });

  it("reads a custom period as the Plant's wall clock, not the browser's", () => {
    const morning = resolved(custom("2026-03-01T06:00", "2026-03-01T18:00"));
    expect(morning.from).toBe("2026-03-01T00:30:00.000Z");
    expect(morning.to).toBe("2026-03-01T12:30:00.000Z");
  });

  it("clamps the end to now and refuses a start in the future", () => {
    expect(resolved(custom("2026-11-01T00:00", "2026-12-01T00:00")).to).toBe(new Date(NOW).toISOString());
    expect(resolvePeriod(custom("2026-11-06T00:00", "2026-11-07T00:00"), NOW, KOLKATA)).toEqual({
      error: "The start is in the future — there are no readings yet.",
    });
    expect(resolvePeriod(custom("2026-03-02T00:00", "2026-03-01T00:00"), NOW, KOLKATA)).toEqual({
      error: "The end must come after the start.",
    });
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    expect("error" in resolvePeriod(custom("2026-02-30T00:00", "2026-03-02T00:00"), NOW, KOLKATA)).toBe(true);
  });

  it("frames a single custom day midnight to midnight, as it frames yesterday", () => {
    expect(resolved(daysPeriod("2026-03-14", "2026-03-14")).day).not.toBeNull();
    expect(resolved(daysPeriod("2026-03-14", "2026-03-15")).day).toBeNull();
  });

  it("gives a 23-hour day its own length on a daylight-saving change", () => {
    const now = Date.UTC(2026, 5, 1);
    const spring = resolved(daysPeriod("2026-03-29", "2026-03-29"), now, "Europe/London");
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3_600_000);
  });
});

describe("the dates a period touches", () => {
  it("are the Plant's, first and last inclusive", () => {
    expect(periodDates(preset("last_month"), NOW, KOLKATA)).toEqual({ first: "2026-10-01", last: "2026-10-31" });
    expect(periodDates(preset("today"), NOW, KOLKATA)).toEqual({ first: "2026-11-05", last: "2026-11-05" });
  });
});

describe("moving through time", () => {
  it("steps a month for a month, and turns this month's neighbour back into a preset", () => {
    expect(shiftPeriod(preset("this_month"), -1, NOW, KOLKATA)).toEqual(preset("last_month"));
    expect(shiftPeriod(preset("last_month"), 1, NOW, KOLKATA)).toEqual(preset("this_month"));
    expect(shiftPeriod(preset("last_month"), -1, NOW, KOLKATA)).toEqual(custom("2026-09-01T00:00", "2026-10-01T00:00"));
  });

  it("steps a day for a day", () => {
    expect(shiftPeriod(preset("today"), -1, NOW, KOLKATA)).toEqual(preset("yesterday"));
    expect(shiftPeriod(preset("yesterday"), -1, NOW, KOLKATA)).toEqual(custom("2026-11-03T00:00", "2026-11-04T00:00"));
  });

  it("will not step into the future", () => {
    expect(shiftPeriod(preset("today"), 1, NOW, KOLKATA)).toBeNull();
    expect(shiftPeriod(preset("this_year"), 1, NOW, KOLKATA)).toBeNull();
    expect(shiftPeriod(preset("30d"), 1, NOW, KOLKATA)).toBeNull();
  });

  it("steps a rolling window by its own length", () => {
    const back = shiftPeriod(preset("7d"), -1, NOW, KOLKATA);
    expect(back).toEqual(custom("2026-10-22T15:30", "2026-10-29T15:30"));
  });

  it("keeps a whole-day stretch whole across a month boundary", () => {
    expect(shiftPeriod(custom("2026-03-25T00:00", "2026-04-04T00:00"), 1, NOW, KOLKATA)).toEqual(
      custom("2026-04-04T00:00", "2026-04-14T00:00"),
    );
  });
});

describe("comparing", () => {
  it("compares with the stretch just before it", () => {
    expect(comparisonPeriod(preset("last_month"), "previous", NOW, KOLKATA)).toEqual(
      custom("2026-09-01T00:00", "2026-10-01T00:00"),
    );
  });

  it("compares a period still running with the same point last year, not all of it", () => {
    expect(comparisonPeriod(preset("this_month"), "last_year", NOW, KOLKATA)).toEqual(
      custom("2025-11-01T00:00", "2025-11-05T15:30"),
    );
  });

  it("puts a year back from 29 February on 28 February", () => {
    expect(comparisonPeriod(daysPeriod("2028-02-29", "2028-02-29"), "last_year", Date.UTC(2028, 5, 1), KOLKATA)).toEqual(
      custom("2027-02-28T00:00", "2027-03-01T00:00"),
    );
  });

  it("compares with nothing when asked for nothing", () => {
    expect(comparisonPeriod(preset("today"), "none", NOW, KOLKATA)).toBeNull();
  });
});

describe("the link", () => {
  it("carries a preset by name", () => {
    expect(periodToParams(preset("30d"))).toEqual({ period: "30d" });
    expect(periodFromParams(new URLSearchParams("period=30d"))).toEqual(preset("30d"));
  });

  it("carries whole days as a person writes them, the last day inclusive", () => {
    const march = custom("2026-03-01T00:00", "2026-04-01T00:00");
    expect(periodToParams(march)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(periodFromParams(new URLSearchParams("from=2026-03-01&to=2026-03-31"))).toEqual(march);
  });

  it("carries a timed stretch to the minute", () => {
    const shift = custom("2026-03-01T06:00", "2026-03-01T18:00");
    expect(periodFromParams(new URLSearchParams(periodToParams(shift)))).toEqual(shift);
  });

  it("ignores a link that names a period badly, rather than guessing", () => {
    expect(periodFromParams(new URLSearchParams("period=fortnight"))).toBeNull();
    expect(periodFromParams(new URLSearchParams("from=2026-02-30&to=2026-03-02"))).toBeNull();
    expect(periodFromParams(new URLSearchParams("from=2026-03-05&to=2026-03-01"))).toBeNull();
    expect(periodFromParams(new URLSearchParams("from=2026-03-05"))).toBeNull();
    expect(periodFromParams(new URLSearchParams(""))).toBeNull();
  });

  it("knows two choices apart", () => {
    expect(samePeriod(preset("today"), preset("today"))).toBe(true);
    expect(samePeriod(preset("today"), preset("yesterday"))).toBe(false);
    expect(samePeriod(custom("2026-03-01T00:00", "2026-04-01T00:00"), custom("2026-03-01T00:00", "2026-04-01T00:00"))).toBe(true);
    expect(samePeriod(null, null)).toBe(true);
  });
});

describe("the words", () => {
  it("names presets, months, years and day ranges", () => {
    expect(periodLabel(preset("30d"), NOW, KOLKATA)).toBe("Last 30 days");
    expect(periodLabel(custom("2026-03-01T00:00", "2026-04-01T00:00"), NOW, KOLKATA)).toBe("March 2026");
    expect(periodLabel(custom("2025-01-01T00:00", "2026-01-01T00:00"), NOW, KOLKATA)).toBe("Last year");
    expect(periodLabel(custom("2024-01-01T00:00", "2025-01-01T00:00"), NOW, KOLKATA)).toBe("2024");
    expect(periodLabel(daysPeriod("2026-03-01", "2026-03-15"), NOW, KOLKATA)).toBe("01-03-2026 – 15-03-2026");
    expect(periodLabel(daysPeriod("2026-03-14", "2026-03-14"), NOW, KOLKATA)).toBe("14-03-2026");
    expect(periodLabel(custom("2026-03-01T06:00", "2026-03-01T18:00"), NOW, KOLKATA)).toBe(
      "01-03-2026 06:00 – 01-03-2026 18:00",
    );
  });

  it("shows a custom period that is exactly yesterday as Yesterday", () => {
    expect(canonical(daysPeriod("2026-11-04", "2026-11-04"), NOW, KOLKATA)).toEqual(preset("yesterday"));
  });

  it("says how coarse the readings are that far back, following the retention tiers", () => {
    const at = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
    expect(detailNote(at(10), NOW)).toBeNull();
    expect(detailNote(at(60), NOW)).toMatch(/1-minute/);
    expect(detailNote(at(400), NOW)).toMatch(/15-minute/);
    expect(detailNote(at(1200), NOW)).toMatch(/hourly/);
  });

  it("states a period's nominal end even while it is still running", () => {
    expect(nominalBounds(preset("this_month"), NOW, KOLKATA)).toEqual({
      from: "2026-11-01T00:00",
      to: "2026-12-01T00:00",
    });
  });
});
