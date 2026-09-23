import { describe, expect, it } from "vitest";
import {
  hourlyPeriods,
  placeRegisterSteps,
  type RegisterReading,
} from "@/dashboards/single-plant/registerSteps";
import { daysOfMonthInZone, recentDaysInZone } from "@/format/datetime";

const H = 3_600_000;
// 00:00 UTC on 23 Sep 2026, a whole-hour origin to keep the arithmetic legible.
const T0 = Date.UTC(2026, 8, 23);

function reading(deviceId: number, hour: number, value: number): RegisterReading {
  return { deviceId, bucket: T0 + hour * H, value };
}

describe("placeRegisterSteps", () => {
  const periods = hourlyPeriods(T0, T0 + 6 * H);
  const now = T0 + 10 * H;

  it("places each step in the later reading's hour, and never the first reading", () => {
    const result = placeRegisterSteps(
      [reading(1, 0, 10), reading(1, 1, 25), reading(1, 2, 45)],
      periods,
      { stepMs: H, now },
    );
    expect(result.periods.map((p) => p.energy)).toEqual([null, 15, 20, null, null, null]);
    expect(result.placed).toBe(35);
    expect(result.periods[0].state).toBe("gap");
  });

  it("integrates each Device on its own, so one missed bucket is not a negative hour", () => {
    // Summed first, hour 2 would read (45) - (25 + 30) = -10.
    const result = placeRegisterSteps(
      [
        reading(1, 1, 25), reading(1, 2, 45),
        reading(2, 1, 30), reading(2, 3, 70),
      ],
      periods,
      { stepMs: H, now },
    );
    expect(result.periods[2]).toMatchObject({ energy: 20, contributors: 1, expected: 2, state: "partial" });
    // Device 2's 40 spans hours 2 and 3 with nothing to split it by — unplaced.
    expect(result.periods[3]).toMatchObject({ energy: null, state: "gap" });
    expect(result.placed).toBe(20);
  });

  it("skips a backwards step and counts it, rather than subtracting it", () => {
    const result = placeRegisterSteps(
      [reading(1, 0, 900), reading(1, 1, 5), reading(1, 2, 12)],
      periods,
      { stepMs: H, now },
    );
    expect(result.backwardsSteps).toBe(1);
    expect(result.periods[1].energy).toBeNull();
    expect(result.periods[2].energy).toBe(7);
  });

  it("marks the hour holding now as current, and later ones as future", () => {
    const result = placeRegisterSteps(
      [reading(1, 0, 0), reading(1, 1, 4), reading(1, 2, 9)],
      periods,
      { stepMs: H, now: T0 + 2.5 * H },
    );
    expect(result.periods.map((p) => p.state)).toEqual([
      "gap", "complete", "current", "future", "future", "future",
    ]);
    expect(result.periods[2].energy).toBe(5);
  });

  it("places a step across a gap when both ends are in the same period", () => {
    const day = [{ start: T0, end: T0 + 24 * H }, { start: T0 + 24 * H, end: T0 + 48 * H }];
    const result = placeRegisterSteps(
      [reading(1, 1, 10), reading(1, 9, 60), reading(1, 30, 90)],
      day,
      { stepMs: H, now: T0 + 40 * H },
    );
    // 10 → 60 stays inside day one; 60 → 90 spans the night into day two.
    expect(result.periods[0].energy).toBe(50);
    expect(result.periods[1].energy).toBeNull();
  });
});

describe("a daily register across the Plant's midnight", () => {
  // A Kolkata Inverter reporting through the night. Its counter reaches 6,000
  // on the 22nd, restarts at the Plant's midnight (18:30 UTC), and reaches
  // 4,000 on the 23rd. Bucket times are UTC hours; each reading is its bucket's last.
  const at = (iso: string) => Date.parse(iso);
  const readings: RegisterReading[] = [
    { deviceId: 1, bucket: at("2026-09-21T19:00:00Z"), value: 0 }, //    00:30–01:30 IST, 22nd
    { deviceId: 1, bucket: at("2026-09-22T12:00:00Z"), value: 6000 }, // 17:30–18:30 IST
    { deviceId: 1, bucket: at("2026-09-22T17:00:00Z"), value: 6000 }, // 22:30–23:30 IST
    { deviceId: 1, bucket: at("2026-09-22T18:00:00Z"), value: 0.2 }, //  23:30–00:30 — reset inside
    { deviceId: 1, bucket: at("2026-09-23T12:00:00Z"), value: 4000.2 }, // 17:30–18:30 IST, 23rd
  ];
  const now = at("2026-09-23T14:00:00Z");
  const days = recentDaysInZone(now, 2, "Asia/Kolkata");

  it("gives each Plant day its own total when the reset is expected", () => {
    const result = placeRegisterSteps(readings, days, { stepMs: H, now, resetsExpected: true });
    expect(result.periods.map((day) => day.energy)).toEqual([6000, 4000.2]);
    expect(result.periods.map((day) => day.state)).toEqual(["complete", "current"]);
    expect(result.backwardsSteps).toBe(0);
    // What the daily tier held for "22 Sep": the UTC day's last reading,
    // taken after the Plant's midnight. That was the bar.
    const utcDay = readings.filter(
      (r) => r.bucket >= at("2026-09-22T00:00:00Z") && r.bucket < at("2026-09-23T00:00:00Z"),
    );
    expect(utcDay[utcDay.length - 1].value).toBe(0.2);
  });

  it("counts the restart as an anomaly when the register is not meant to reset", () => {
    const result = placeRegisterSteps(readings, days, { stepMs: H, now });
    expect(result.backwardsSteps).toBe(1);
    expect(result.periods[1].energy).toBe(4000);
  });
});

describe("hourlyPeriods", () => {
  it("starts a Kolkata day at 00:30, the first UTC hour after its midnight", () => {
    const midnight = Date.UTC(2026, 8, 22, 18, 30);
    const periods = hourlyPeriods(midnight, midnight + 24 * H);
    expect(new Date(periods[0].start).toISOString()).toBe("2026-09-22T19:00:00.000Z");
    expect(periods).toHaveLength(24);
  });
});

describe("recentDaysInZone", () => {
  it("returns the last n Plant days, oldest first, ending today", () => {
    const days = recentDaysInZone(Date.UTC(2026, 8, 23, 6), 7, "Asia/Kolkata");
    expect(days).toHaveLength(7);
    expect(new Date(days[0].start).toISOString()).toBe("2026-09-16T18:30:00.000Z");
    expect(new Date(days[6].start).toISOString()).toBe("2026-09-22T18:30:00.000Z");
    days.slice(1).forEach((day, index) => expect(day.start).toBe(days[index].end));
  });
});

describe("daysOfMonthInZone", () => {
  it("returns every day of the Plant's month, each starting at its own midnight", () => {
    const days = daysOfMonthInZone(Date.UTC(2026, 8, 23, 6), "Asia/Kolkata");
    expect(days).toHaveLength(30);
    expect(days[0].day).toBe(1);
    expect(new Date(days[0].start).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(new Date(days[29].end).toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });

  it("is the Plant's month, not the browser's, either side of midnight", () => {
    // 20:00 UTC on 30 Sep is already 1 Oct in Kolkata.
    const days = daysOfMonthInZone(Date.UTC(2026, 8, 30, 20), "Asia/Kolkata");
    expect(days).toHaveLength(31);
    expect(new Date(days[0].start).toISOString()).toBe("2026-09-30T18:30:00.000Z");
  });

  it("keeps each day on its own midnight across a daylight-saving change", () => {
    const days = daysOfMonthInZone(Date.UTC(2026, 9, 15), "Europe/London");
    const change = days.find((d) => d.day === 25);
    expect(change && change.end - change.start).toBe(25 * H);
    expect(new Date(days[25].start).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});
