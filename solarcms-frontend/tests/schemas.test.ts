/**
 * The zod boundary. Parsing rather than casting is what turns an API null into a
 * union the caller must handle, instead of NaN reaching a chart axis (§1).
 */

import { describe, expect, it } from "vitest";
import {
  KpiFigureSchema,
  LiveFrameSchema,
  MeSchema,
  PlantKpisSchema,
  ReadingsResponseSchema,
  SldSchema,
  operatorNeedsThreshold,
} from "@/api/schemas";

describe("KPI figures", () => {
  it("keeps a null value as null rather than coercing it to 0", () => {
    const parsed = KpiFigureSchema.parse({
      value: null,
      variant: "poa_uncorrected",
      undefined_reason: "no irradiation in period",
    });
    expect(parsed.value).toBeNull();
    expect(parsed.undefined_reason).toBe("no irradiation in period");
  });

  it("normalises a NUMERIC that arrives as a string", () => {
    const parsed = KpiFigureSchema.parse({
      value: "0.812",
      variant: "poa_uncorrected",
      undefined_reason: null,
    });
    expect(parsed.value).toBe(0.812);
  });

  it("parses a whole plant KPI payload as the API returns it", () => {
    const parsed = PlantKpisSchema.parse({
      plant_id: 1,
      period: "today",
      energy_kwh: 1234.5,
      performance_ratio: { value: null, variant: "poa_uncorrected", undefined_reason: "night" },
      cuf: { value: 0.21, variant: "ac_nameplate", undefined_reason: null },
      availability: { value: 1, variant: "comm_uptime", undefined_reason: null },
      co2_avoided_kg: { value: 1012.29, variant: "grid_factor", undefined_reason: null },
      assumptions_note: "provisional",
    });
    expect(parsed.performance_ratio.value).toBeNull();
    expect(parsed.cuf.value).toBe(0.21);
  });
});

describe("readings", () => {
  it("carries the tier that actually served the query", () => {
    const parsed = ReadingsResponseSchema.parse({
      tier: "agg_1d",
      resolution_requested: "auto",
      from: "2025-09-11T00:00:00+00:00",
      to: "2026-09-11T00:00:00+00:00",
      count: 1,
      items: [
        {
          bucket: "2026-09-10T00:00:00+00:00",
          device_id: 1,
          tag_id: 12,
          tag_code: "AC_ACTIVE_POWER",
          value: "198.5",
          quality: 0,
          avg_value: 198.5,
          min_value: 0,
          max_value: 400,
          last_value: 12,
          sample_count: 1440,
          rollup_method: "avg",
        },
      ],
    });
    expect(parsed.tier).toBe("agg_1d");
    expect(parsed.items[0].value).toBe(198.5);
  });

  it("clamps an out-of-contract quality code to unparseable rather than trusting it", () => {
    const parsed = ReadingsResponseSchema.parse({
      tier: "readings",
      resolution_requested: "auto",
      from: "a",
      to: "b",
      count: 1,
      items: [
        { bucket: "c", device_id: 1, tag_id: 2, tag_code: "T", value: 1, quality: 7 },
      ],
    });
    expect(parsed.items[0].quality).toBe(3);
  });
});

describe("identity", () => {
  it("keeps an empty plants array empty — zero means zero (I-5)", () => {
    const parsed = MeSchema.parse({
      user_id: 1,
      client_id: 7,
      role: "employee",
      platform_admin: false,
      permissions: ["dashboard.view"],
      plants: [],
      dashboards: ["portfolio"],
    });
    expect(parsed.plants).toEqual([]);
    expect(parsed.permissions).toContain("dashboard.view");
  });
});

describe("the live frame", () => {
  it("keys values by tag_id as a string", () => {
    const parsed = LiveFrameSchema.parse({
      client_id: 7,
      plant_id: 15,
      device_id: 42,
      values: { "12": 198.5, "13": "11.37" },
      at: "2026-09-11T12:00:03+00:00",
    });
    expect(parsed.values["12"]).toBe(198.5);
    expect(parsed.values["13"]).toBe(11.37);
  });
});

describe("the SLD payload", () => {
  it("parses a recursive tree and keeps the two side lists", () => {
    const parsed = SldSchema.parse({
      plant_id: 1,
      device_count: 3,
      roots: [
        {
          device_id: 3,
          code: "MFM-01",
          name: "Main Meter",
          type: "MFM",
          variant: null,
          collector_code: null,
          children: [
            {
              device_id: 4,
              code: "INV-01",
              name: "Inverter 1",
              type: "INVERTER",
              variant: "central",
              // The enclosure this Device sits in. A box drawn around the
              // node, never a node — nothing is wired through a room.
              collector_code: "MCR",
              children: [],
            },
          ],
        },
      ],
      excluded_not_in_power_path: [{ device_id: 5, code: "WMS-01", type: "WMS" }],
      orphaned: [],
      collectors: [
        { code: "MCR", device_ids: [4], device_count: 1, in_power_path_count: 1 },
      ],
    });
    expect(parsed.roots[0].children[0].variant).toBe("central");
    expect(parsed.roots[0].children[0].collector_code).toBe("MCR");
    // The Collector is never a node in the tree — it is a roll-up beside it.
    expect(parsed.roots).toHaveLength(1);
    expect(parsed.collectors[0].code).toBe("MCR");
    // Not an error: these are real, monitored Devices carrying no current.
    expect(parsed.excluded_not_in_power_path).toHaveLength(1);
  });
});

describe("alarm rule operators (§7.3)", () => {
  it("says a boolean operator takes no threshold", () => {
    expect(operatorNeedsThreshold("is_true")).toBe(false);
    expect(operatorNeedsThreshold("is_false")).toBe(false);
    expect(operatorNeedsThreshold("gt")).toBe(true);
  });
});

describe("ReadingsResponseSchema", () => {
  const base = {
    tier: "agg_15m",
    resolution_requested: "agg_15m",
    from: "2026-09-21T15:07:00Z",
    to: "2026-09-22T15:07:00Z",
    count: 1,
  };

  it("accepts sample_count as a JSON string", () => {
    // `count(*)` is BIGINT, and this driver path serialises BIGINT as a string
    // to avoid the 2^53 precision cliff. Declared as `z.number()` this failed
    // for every aggregate-tier response, and because the envelope is parsed as
    // a whole, one string here blanked the entire chart.
    const parsed = ReadingsResponseSchema.parse({
      ...base,
      items: [
        {
          bucket: "2026-09-21T16:30:00Z",
          device_id: 40,
          tag_id: 53,
          tag_code: "GTI",
          value: -1.5,
          avg_value: -1.5,
          min_value: -2,
          max_value: -1,
          last_value: -1,
          sample_count: "10",
          quality: 1,
          rollup_method: "avg",
        },
      ],
    });
    expect(parsed.items[0].sample_count).toBe(10);
  });

  it("still accepts it as a number, and absent on the raw tier", () => {
    const parsed = ReadingsResponseSchema.parse({
      ...base,
      tier: "readings",
      items: [
        { bucket: "2026-09-21T16:30:00Z", device_id: 40, tag_id: 53, tag_code: "GTI", value: 1, quality: 0, sample_count: 3 },
        { bucket: "2026-09-21T16:31:00Z", device_id: 40, tag_id: 53, tag_code: "GTI", value: 2, quality: 0 },
      ],
    });
    expect(parsed.items[0].sample_count).toBe(3);
    expect(parsed.items[1].sample_count).toBeUndefined();
  });
});
