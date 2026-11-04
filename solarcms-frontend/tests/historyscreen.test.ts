/**
 * The rules behind Performance History and the long-period charts:
 *
 * - the calendar shades only what was measured and ranks only whole days
 *   (Guardrails 23, 30), and keeps an impossible PR out of its scale (33);
 * - a zoomed span's finer readings replace the coarse ones there and never
 *   join them across the seam (23);
 * - a band is drawn only where it is a fact — one Device, an averaged Tag;
 * - Alarms and planned work become marks, the worst kept when there are many;
 * - a chart's CSV is what is drawn, a gap left out rather than written as 0.
 */

import { describe, expect, it } from "vitest";
import type { HistoryDay } from "@/api/endpoints/history";
import type { Alarm, ReadingPoint } from "@/api/schemas";
import { seriesFromReadings, type TrendPoint } from "@/api/useSlotTrend";
import { mergeDetail } from "@/api/useSeries";
import { sameFrame } from "@/api/trendWindow";
import { alarmEvents, maintenanceEvents } from "@/api/useHistory";
import { limitEvents, MAX_EVENT_MARKS, eventSummary, type ChartEvent } from "@/components/charts/TrendChart";
import { rowsCsv, trendCsv, exportStem } from "@/components/charts/csv";
import {
  alignByIndex,
  bestAndWorst,
  calendarMonths,
  change,
  displayDate,
  displayMonth,
  fillAlpha,
  rankable,
  scaleBounds,
  shade,
  SHADE_RANGE,
  unattributedEnergy,
} from "@/dashboards/history/metrics";

function day(date: string, energy: number | null, extra: Partial<HistoryDay> = {}): HistoryDay {
  return {
    date,
    in_progress: false,
    energy_kwh: energy,
    irradiation_kwh_m2: null,
    specific_yield: null,
    performance_ratio: null,
    performance_ratio_flagged: false,
    peak_power_kw: null,
    coverage: energy === null ? null : 100,
    ...extra,
  };
}

describe("the calendar's scale", () => {
  it("is bounded by the measured, plausible days only", () => {
    const days = [
      day("2026-03-01", 100),
      day("2026-03-02", null),
      day("2026-03-03", 400),
      day("2026-03-04", 250, { performance_ratio: 2400, performance_ratio_flagged: true }),
      day("2026-03-05", 300, { performance_ratio: 80 }),
    ];
    expect(scaleBounds(days, "energy_kwh")).toEqual({ min: 100, max: 400 });
    // The impossible PR does not wash every other day pale.
    expect(scaleBounds(days, "performance_ratio")).toEqual({ min: 80, max: 80 });
    expect(scaleBounds([day("2026-03-01", null)], "energy_kwh")).toBeNull();
  });

  it("anchors at zero for a quantity that starts there, so a tenth of a day looks like one", () => {
    expect(shade(40, { min: 40, max: 400 })).toBeCloseTo(0.1);
    expect(shade(400, { min: 40, max: 400 })).toBe(1);
  });

  it("stretches days that sit close together, rather than painting them one shade", () => {
    const bounds = { min: 380, max: 400 };
    expect(shade(380, bounds)).toBe(0);
    expect(shade(390, bounds)).toBeCloseTo(0.5);
  });

  it("runs one hue light to dark, never transparent", () => {
    expect(fillAlpha(0)).toBe(SHADE_RANGE.lightest);
    expect(fillAlpha(1)).toBe(SHADE_RANGE.darkest);
    expect(fillAlpha(0)).toBeGreaterThan(0);
  });
});

describe("ranking days", () => {
  const days = [
    day("2026-03-01", 300),
    day("2026-03-02", 100, { coverage: 40 }), // partial: the lowest, and not the worst
    day("2026-03-03", null),
    day("2026-03-04", 200),
    day("2026-03-05", 500, { in_progress: true }),
  ];

  it("names the best and worst whole, measured days", () => {
    const extremes = bestAndWorst(days, "energy_kwh");
    expect(extremes?.best.date).toBe("2026-03-01");
    expect(extremes?.worst.date).toBe("2026-03-04");
  });

  it("counts what it could not rank, and why", () => {
    expect(rankable(days, "energy_kwh")).toMatchObject({ inProgress: 1, partial: 1, unmeasured: 1, flagged: 0 });
  });

  it("calls no day best by a figure that describes the day rather than the Plant", () => {
    expect(bestAndWorst(days, "irradiation_kwh_m2")).toBeNull();
    expect(bestAndWorst(days, "coverage")).toBeNull();
  });

  it("ranks nothing with fewer than two days to rank", () => {
    expect(bestAndWorst([day("2026-03-01", 300)], "energy_kwh")).toBeNull();
  });
});

describe("energy no day can claim", () => {
  it("is the period's total less its days, when that is more than rounding", () => {
    const days = [day("2026-09-17", 646), day("2026-09-18", 26_596), day("2026-09-19", null)];
    expect(unattributedEnergy(99_200, days)).toBeCloseTo(71_958);
    expect(unattributedEnergy(27_242.4, days)).toBeNull();
    expect(unattributedEnergy(null, days)).toBeNull();
  });
});

describe("the calendar's shape", () => {
  it("lays a month out Monday-first, with the period's days and the rest of the month", () => {
    const [march] = calendarMonths([day("2026-03-10", 1), day("2026-03-11", 2)]);
    expect(march?.title).toBe("March 2026");
    // 1 March 2026 is a Sunday: six empty cells before it.
    expect(march?.weeks[0]?.slice(0, 6).every((cell) => cell === null)).toBe(true);
    expect(march?.weeks[0]?.[6]?.date).toBe("2026-03-01");
    const cells = march!.weeks.flat().filter((cell) => cell !== null);
    expect(cells).toHaveLength(31);
    expect(cells.find((cell) => cell!.date === "2026-03-01")?.day).toBeNull();
    expect(cells.find((cell) => cell!.date === "2026-03-10")?.day?.energy_kwh).toBe(1);
    expect(march!.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("gives each month the period touches its own calendar, in order", () => {
    const months = calendarMonths([day("2026-02-27", 1), day("2026-03-02", 1), day("2024-02-29", 1)]);
    expect(months.map((month) => month.key)).toEqual(["2024-02", "2026-02", "2026-03"]);
    expect(months[0]!.weeks.flat().filter(Boolean)).toHaveLength(29);
  });

  it("writes dates the platform's way", () => {
    expect(displayDate("2026-03-14")).toBe("14-03-2026");
    expect(displayMonth("2026-03")).toBe("March 2026");
  });
});

describe("against another period", () => {
  it("is a relative change for a quantity and a difference in points for a percentage", () => {
    expect(change(110, 100, "kWh")).toEqual({ value: 0.1, kind: "relative" });
    expect(change(82, 79, "%")).toEqual({ value: 3, kind: "points" });
  });

  it("is unknown where either side is, or the base is zero", () => {
    expect(change(null, 100, "kWh")).toBeNull();
    expect(change(100, null, "kWh")).toBeNull();
    expect(change(100, 0, "kWh")).toBeNull();
  });

  it("lays day n on day n, and leaves the end empty when the other period is shorter", () => {
    const aligned = alignByIndex([{ date: "2026-03-30" }, { date: "2026-03-31" }], ["Feb 27"]);
    expect(aligned).toEqual([
      { date: "2026-03-30", other: "Feb 27" },
      { date: "2026-03-31", other: null },
    ]);
  });
});

// ── Long-period charts ───────────────────────────────────────────────────────

function reading(bucket: string, device: number, value: number, extra: Partial<ReadingPoint> = {}): ReadingPoint {
  return {
    bucket,
    device_id: device,
    tag_id: 7,
    tag_code: "T",
    value,
    quality: 0,
    avg_value: value,
    min_value: value - 5,
    max_value: value + 5,
    rollup_method: "avg",
    ...extra,
  } as ReadingPoint;
}

describe("the band", () => {
  it("is the bucket's own lowest and highest, for one Device's averaged Tag", () => {
    const { points } = seriesFromReadings([reading("2026-03-01T00:00:00Z", 1, 50)], "first", "agg_1h");
    expect(points[0]).toMatchObject({ value: 50, low: 45, high: 55 });
  });

  it("is absent for a sum of several Devices, whose lowest is not the sum of theirs", () => {
    const { points } = seriesFromReadings(
      [reading("2026-03-01T00:00:00Z", 1, 50), reading("2026-03-01T00:00:00Z", 2, 60)],
      "sum",
      "agg_1h",
    );
    expect(points[0]?.value).toBe(110);
    expect(points[0]?.low).toBeUndefined();
  });

  it("is absent for a counter, whose value is its last reading", () => {
    const { points } = seriesFromReadings(
      [reading("2026-03-01T00:00:00Z", 1, 50, { rollup_method: "last" })],
      "first",
      "agg_1h",
    );
    expect(points[0]?.low).toBeUndefined();
  });

  it("is absent on the raw tier, which carries no spread", () => {
    const { points } = seriesFromReadings(
      [reading("2026-03-01T00:00:00Z", 1, 50, { min_value: undefined, max_value: undefined, rollup_method: undefined })],
      "first",
      "readings",
    );
    expect(points[0]?.low).toBeUndefined();
  });
});

const point = (at: string, value: number | null): TrendPoint => ({ at, value, contributors: value === null ? 0 : 1 });

describe("finer readings in a zoomed span", () => {
  const hour = (h: number) => `2026-03-01T${String(h).padStart(2, "0")}:00:00.000Z`;
  const coarse = [point(hour(0), 1), point(hour(1), 2), point(hour(2), 3), point(hour(3), 4)];
  const fine = [
    point("2026-03-01T01:00:00.000Z", 10),
    point("2026-03-01T01:30:00.000Z", 11),
    point("2026-03-01T02:00:00.000Z", 12),
    point("2026-03-01T02:30:00.000Z", 13),
  ];
  const window = { from: Date.parse(hour(1)), to: Date.parse(hour(3)) };

  it("replaces the coarse buckets the span touches, and keeps the rest", () => {
    const merged = mergeDetail(coarse, "agg_1h", fine, window).filter((p) => p.value !== null);
    expect(merged.map((p) => p.value)).toEqual([1, 10, 11, 12, 13, 4]);
  });

  it("breaks the line at each seam rather than joining two resolutions", () => {
    const merged = mergeDetail(coarse, "agg_1h", fine, window);
    expect(merged.filter((p) => p.value === null)).toHaveLength(2);
  });

  it("leaves the coarse series alone until finer readings arrive", () => {
    expect(mergeDetail(coarse, "agg_1h", [], window)).toBe(coarse);
  });
});

function alarm(id: number, at: string, severity: Alarm["severity"]): Alarm {
  return {
    id,
    state: "resolved",
    severity,
    opened_at: at,
    acknowledged_at: null,
    resolved_at: null,
    message: `Alarm ${id}`,
    trigger_value: null,
    classification: null,
    escalation_level: 0,
    device_id: 3,
    plant_id: 1,
    device_code: "INVERTER_3",
    rule_code: "R",
    tag_code: null,
  };
}

describe("one period, still running", () => {
  const day = 86_400_000;
  it("is the same frame when its end has moved on a minute", () => {
    expect(sameFrame({ from: 0, to: 7 * day }, { from: 60_000, to: 7 * day + 60_000 })).toBe(true);
    expect(sameFrame({ from: 0, to: 3_600_000 }, { from: 0, to: 3_660_000 })).toBe(true);
  });
  it("is a different frame for another period", () => {
    expect(sameFrame({ from: 0, to: 7 * day }, { from: -7 * day, to: 0 })).toBe(false);
    expect(sameFrame({ from: 0, to: 7 * day }, { from: 0, to: 30 * day })).toBe(false);
  });
});

describe("events on the time axis", () => {
  const range = { from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" };

  it("marks the Alarms opened inside the period, coloured by their own severity", () => {
    const events = alarmEvents(
      [
        alarm(1, "2026-03-01T06:00:00Z", "critical"),
        alarm(2, "2026-03-01T07:00:00Z", "medium"),
        alarm(3, "2026-03-02T06:00:00Z", "high"),
      ],
      range,
    );
    expect(events.map((event) => [event.key, event.tone])).toEqual([
      ["alarm-1", "bad"],
      ["alarm-2", "warn"],
    ]);
    expect(events[0]?.label).toContain("INVERTER_3");
  });

  it("clips planned work to the period, keeps the Plant-wide windows on a Device's screen", () => {
    const windows = [
      { id: 1, plant_id: 1, device_id: null, device_code: null, starts_at: "2026-02-28T20:00:00Z", ends_at: "2026-03-01T04:00:00Z", reason: "Washing" },
      { id: 2, plant_id: 1, device_id: 9, device_code: "INVERTER_9", starts_at: "2026-03-01T10:00:00Z", ends_at: null, reason: null },
      { id: 3, plant_id: 1, device_id: 3, device_code: "INVERTER_3", starts_at: "2026-03-05T00:00:00Z", ends_at: "2026-03-06T00:00:00Z", reason: null },
    ];
    const forDevice3 = maintenanceEvents(windows, range, 3);
    expect(forDevice3.map((event) => event.key)).toEqual(["maintenance-1"]);
    expect(forDevice3[0]?.at).toBe(Date.parse(range.from));
    const plantWide = maintenanceEvents(windows, range, null);
    // An open-ended window runs to the period's end.
    expect(plantWide.find((event) => event.key === "maintenance-2")?.end).toBe(Date.parse(range.to));
  });

  it("keeps every stretch and the most severe moments when there are too many to draw", () => {
    const many: ChartEvent[] = [
      { key: "s", at: 0, end: 10, label: "work", tone: "neutral" },
      ...Array.from({ length: 60 }, (_, index) => ({
        key: `a${index}`,
        at: index,
        label: "a",
        tone: (index < 5 ? "bad" : "info") as ChartEvent["tone"],
      })),
    ];
    const shown = limitEvents(many);
    expect(shown.shown).toHaveLength(MAX_EVENT_MARKS);
    expect(shown.shown.filter((event) => event.tone === "bad")).toHaveLength(5);
    expect(shown.shown.some((event) => event.key === "s")).toBe(true);
    expect(eventSummary(shown)).toMatch(/21 less severe not marked/);
  });
});

describe("a chart's CSV", () => {
  it("is what is drawn: a gap left out, never written as 0, with a byte-order mark for Excel", () => {
    const text = trendCsv(
      [point("2026-03-01T00:30:00Z", 12.5), point("2026-03-01T01:30:00Z", null), point("2026-03-01T02:30:00Z", 0)],
      { label: "Plant power", unit: "kW", tier: "agg_1h", timezone: "Asia/Kolkata" },
    );
    expect(text.startsWith("﻿")).toBe(true);
    const lines = text.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("Time,Plant power (kW),Devices");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^01-03-2026 06:00(:00)?,12.5,1$/);
    expect(lines[2]).toMatch(/,0,1$/);
  });

  it("quotes a cell that holds a comma, and leaves an unknown blank", () => {
    const text = rowsCsv(["Date", "Note"], [["01-03-2026", "a, b"], ["02-03-2026", null]]);
    expect(text).toContain('"a, b"');
    expect(text.slice(1).trim().split("\r\n")[2]).toBe("02-03-2026,");
  });

  it("names the file from its parts, safely", () => {
    expect(exportStem("SF NORTH", "power", "2026-03-01", null)).toBe("SF_NORTH_power_2026-03-01");
  });
});
