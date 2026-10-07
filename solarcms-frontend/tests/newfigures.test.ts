/**
 * The figures added on 8 Oct 2026: yesterday's energy read back from a
 * register, status-code meanings, and the power trend's station series'
 * colours. Each is a rule that could print a confident wrong number.
 */

import { describe, expect, it } from "vitest";
import {
  combineDays,
  dailyRegisterDay,
  lifetimeAdvanceDay,
  type RegisterBucket,
} from "@/api/useYesterdayEnergy";
import { NO_MEANINGS, statusLookup, statusText } from "@/format/statusCode";
import { presentable } from "@/api/useLatestValues";
import { COMPARE_SLOT, compareSlot } from "@/dashboards/single-plant/usePowerComparison";

const at = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, 7, hour, minute)).toISOString();

function rising(fromHour: number, toHour: number, total: number, lastHour: number): RegisterBucket[] {
  const out: RegisterBucket[] = [];
  for (let hour = fromHour; hour <= lastHour; hour += 1) {
    const done = Math.min(1, Math.max(0, (hour - fromHour) / (toHour - fromHour)));
    const next = Math.min(1, Math.max(0, (hour + 1 - fromHour) / (toHour - fromHour)));
    out.push({ at: at(hour), min: total * done, max: total * next, last: total * next });
  }
  return out;
}

describe("dailyRegisterDay", () => {
  it("is the register's highest value once the day is over", () => {
    const day = dailyRegisterDay(rising(1, 12, 100, 20));
    expect(day.total).toBeCloseTo(100);
    expect(day.rising).toBe(false);
  });

  it("says at least when readings stopped while it was still rising", () => {
    const day = dailyRegisterDay(rising(1, 12, 100, 8));
    expect(day.rising).toBe(true);
    expect(day.total).toBeLessThan(100);
  });

  it("reads after a restart, not the day before's carried total", () => {
    const carried: RegisterBucket[] = [
      { at: at(0), min: 120, max: 120, last: 120 },
      { at: at(0, 30), min: 120, max: 120, last: 120 },
    ];
    const day = dailyRegisterDay([...carried, ...rising(1, 12, 100, 20)]);
    expect(day.total).toBeCloseTo(100);
  });

  it("does not take a small dip for a restart", () => {
    const buckets = rising(1, 12, 100, 20).map((bucket, index) =>
      index > 15 ? { ...bucket, min: bucket.min * 0.94, max: bucket.max * 0.94 } : bucket,
    );
    expect(dailyRegisterDay(buckets).total).toBeCloseTo(100);
  });

  it("is unknown with no readings — never zero", () => {
    expect(dailyRegisterDay([]).total).toBeNull();
  });
});

describe("lifetimeAdvanceDay", () => {
  it("is how far the register moved over the day", () => {
    const buckets = rising(1, 12, 50, 20).map((bucket) => ({
      ...bucket,
      min: bucket.min + 1000,
      max: bucket.max + 1000,
      last: bucket.last + 1000,
    }));
    expect(lifetimeAdvanceDay(buckets).total).toBeCloseTo(50);
  });

  it("never counts a backwards register as negative energy", () => {
    const buckets: RegisterBucket[] = [
      { at: at(1), min: 900, max: 900, last: 900 },
      { at: at(2), min: 5, max: 5, last: 5 },
    ];
    expect(lifetimeAdvanceDay(buckets).total).toBeNull();
  });
});

describe("combineDays", () => {
  it("sums the Devices that reported and leaves the silent ones out", () => {
    const result = combineDays(
      [
        { total: 10, rising: false },
        { total: null, rising: false },
        { total: 5, rising: true },
      ],
      "sum",
    );
    expect(result).toEqual({ value: 15, rising: true });
  });

  it("is unknown when nobody reported", () => {
    expect(combineDays([{ total: null, rising: false }], "sum").value).toBeNull();
  });
});

describe("status code meanings", () => {
  const lookup = statusLookup({
    plant_id: 2,
    can_edit: true,
    observed: [],
    codes: [
      {
        id: 1,
        device_type_code: "INVERTER",
        tag_code: "DEVICE_STATUS",
        tag_name: "Device Status",
        code: 512,
        label: "Grid connected",
        kind: "normal",
        note: null,
        updated_at: "2026-10-08T00:00:00Z",
        updated_by: null,
      },
    ],
  });

  it("finds the client's meaning by Type, reading and code", () => {
    expect(lookup("INVERTER", "DEVICE_STATUS", 512)?.label).toBe("Grid connected");
  });

  it("returns nothing for a code nobody described, so it shows as sent", () => {
    expect(lookup("INVERTER", "DEVICE_STATUS", 40960)).toBeNull();
    expect(lookup("MFM", "DEVICE_STATUS", 512)).toBeNull();
    expect(statusText(40960, null)).toBe("40960");
  });

  it("never matches a value that is not a whole number", () => {
    expect(lookup("INVERTER", "DEVICE_STATUS", 512.5)).toBeNull();
  });

  it("has no meanings before any are loaded", () => {
    expect(NO_MEANINGS("INVERTER", "DEVICE_STATUS", 512)).toBeNull();
  });
});

describe("compareSlot", () => {
  it("keeps the fixed series on their slots", () => {
    expect(compareSlot("power", [])).toBe(COMPARE_SLOT.power);
    expect(compareSlot("radiation", [])).toBe(COMPARE_SLOT.radiation);
  });

  it("gives each station series its own slot after them, by catalogue order", () => {
    const catalogue = ["GTI", "GHI", "DIFFUSE_RADIATION"];
    expect(compareSlot("wms:GTI", catalogue)).toBe(4);
    expect(compareSlot("wms:GHI", catalogue)).toBe(5);
    expect(compareSlot("wms:DIFFUSE_RADIATION", catalogue)).toBe(6);
  });
});

describe("presentable", () => {
  const point = (quality: number, tagId = 31) => ({
    bucket: "2026-10-07T20:57:00Z",
    device_id: 21,
    tag_id: tagId,
    tag_code: "DEVICE_STATUS",
    value: 40960,
    quality,
  });
  const codes = new Set([31]);

  it("shows a status code flagged only for its assumed range", () => {
    expect(presentable(point(1) as never, codes)).toBe(true);
  });

  it("still hides a stale or unreadable status code", () => {
    expect(presentable(point(2) as never, codes)).toBe(false);
    expect(presentable(point(3) as never, codes)).toBe(false);
  });

  it("still hides an out-of-range measurement", () => {
    expect(presentable(point(1, 3) as never, codes)).toBe(false);
  });
});
