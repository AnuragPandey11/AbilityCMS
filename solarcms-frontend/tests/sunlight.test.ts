/**
 * The PR card's account of its sunlight: silent when every station gave its
 * own daily total, one line when it did not.
 *
 * The case is VARDHMAN_GROUP's SPINNING_AND_GENERAL_MILLS (15 Oct 2026): two
 * stations whose daily total reads 0 all day while their live GHI reads the
 * sun. PR now divides by that live GHI added up — a different claim from the
 * one the dial normally makes, so the card must say it.
 */

import { describe, expect, it } from "vitest";
import { IrradiationSchema, PlantKpisSchema, PrBasisSchema, ResolvedSlotSchema } from "@/api/schemas";
import {
  combineNotes,
  prBasisNote,
  spanWords,
  stationSourceWords,
  sunlightNote,
  withheldWords,
} from "@/format/sunlight";

function station(
  code: string,
  source: "register" | "live_ghi" | null,
  kwh: number,
  excluded: string | null = null,
) {
  return {
    device_id: code.length,
    device_code: code,
    source,
    kwh_m2: kwh,
    register_kwh_m2: source === "register" ? kwh : 0,
    live_kwh_m2: kwh,
    excluded_reason: excluded,
  };
}

function irradiation(stations: ReturnType<typeof station>[], spread: number | null = null) {
  return IrradiationSchema.parse({
    value: 1,
    station_count: stations.length,
    undefined_reason: null,
    from_live_ghi: stations.some((s) => s.source === "live_ghi"),
    spread,
    stations,
  });
}

describe("sunlightNote", () => {
  it("says nothing when every station gave its own daily total", () => {
    expect(sunlightNote(irradiation([station("WMS", "register", 5)]))).toBeNull();
    expect(sunlightNote(null)).toBeNull();
  });

  it("says when PR divides by live GHI added up, and names the stations", () => {
    const note = sunlightNote(
      irradiation([station("WMS", "live_ghi", 1.5), station("WMS_WEST", "live_ghi", 1.56)]),
    );
    expect(note?.text).toBe("Sunlight from live GHI");
    expect(note?.warn).toBe(false);
    expect(note?.title).toContain("WMS and WMS_WEST");
    expect(note?.title).toContain("not a total the station sent");
  });

  it("warns when a station is left out, with its reason", () => {
    const note = sunlightNote(
      irradiation([
        station("WMS", "register", 5),
        station("WMS_WEST", "register", 0, "read 0.00 kWh/m² while WMS read 5.00 — not measuring"),
      ]),
    );
    expect(note?.text).toBe("WMS_WEST left out");
    expect(note?.warn).toBe(true);
    expect(note?.title).toContain("WMS_WEST is left out: it read 0.00 kWh/m²");
  });

  it("warns when the stations used disagree", () => {
    const note = sunlightNote(
      irradiation([station("WMS", "register", 5), station("WMS_WEST", "register", 6)], 0.18),
    );
    expect(note?.text).toBe("Stations 18% apart");
    expect(note?.warn).toBe(true);
  });

  it("an older server, sending no stations, parses and says nothing", () => {
    const parsed = IrradiationSchema.parse({ value: 2.1, station_count: 1, undefined_reason: null });
    expect(parsed.stations).toEqual([]);
    expect(sunlightNote(parsed)).toBeNull();
  });
});

describe("stationSourceWords", () => {
  it("names each station's part", () => {
    expect(stationSourceWords(station("WMS", "register", 5))).toBe("its own daily total");
    expect(stationSourceWords(station("WMS", "live_ghi", 1.5))).toMatch(/^live GHI/);
    expect(stationSourceWords(station("WMS", "register", 0, "read 0.00"))).toBe(
      "left out — not measuring",
    );
  });
});

describe("withheld readings", () => {
  it("a slot's held-back readings become one tooltip sentence", () => {
    expect(withheldWords(undefined)).toBeNull();
    expect(withheldWords([])).toBeNull();
    expect(
      withheldWords([
        {
          device_id: 1,
          device_code: "WMS",
          tag_code: "GTI",
          value: 0,
          reason: "GTI reads 0 W/m² while GHI at WMS_WEST reads 96 — not measuring",
        },
      ]),
    ).toBe("Held back as not measuring: WMS: GTI reads 0 W/m² while GHI at WMS_WEST reads 96 — not measuring.");
  });

  it("a slot from an older server, without them, still parses", () => {
    const parsed = ResolvedSlotSchema.parse({
      slot_code: "env.irradiance",
      label: "Irradiance",
      position: 1,
      value: 95.8,
      unit: "W/m2",
      undefined_reason: null,
      source: null,
    });
    expect(parsed.withheld).toBeUndefined();
    expect(withheldWords(parsed.withheld)).toBeNull();
  });
});

describe("what PR stands on", () => {
  // SPINNING_AND_GENERAL_MILLS, 21 Oct 2026: the station's live GHI had no
  // afternoon, so PR left 11:30–20:00 out of both sides.
  const zone = "Asia/Kolkata";
  const now = new Date("2026-10-21T15:00:00Z");
  const outage = PrBasisSchema.parse({
    energy_kwh: "820.5",
    irradiation_kwh_m2: 2.9,
    energy_share: 0.41,
    left_out: [
      {
        from: "2026-10-21T06:00:00Z",
        to: "2026-10-21T14:30:00Z",
        reason: "no_sunlight",
        words: "no sunlight readings",
        energy_kwh: 1180.2,
        irradiation_kwh_m2: null,
        devices: [],
      },
    ],
    left_out_count: 1,
    stations_set_aside: [],
  });

  it("names the share and the stretch, in the Plant's time", () => {
    const note = prBasisNote(outage, zone, now);
    expect(note?.text).toBe("PR from 41% of the energy · no sunlight readings 11:30–20:00");
    expect(note?.title).toContain("1,180 kWh");
    expect(note?.warn).toBe(true);
  });

  it("says nothing when PR stands on all the energy", () => {
    expect(
      prBasisNote(
        PrBasisSchema.parse({ energy_kwh: 10, irradiation_kwh_m2: 1, energy_share: 1 }),
        zone,
        now,
      ),
    ).toBeNull();
  });

  it("names a station set aside", () => {
    const dead = PrBasisSchema.parse({
      energy_kwh: 0,
      irradiation_kwh_m2: 0,
      energy_share: 0,
      left_out: [],
      stations_set_aside: [
        { device_id: 30, device_code: "WMS", hours: 9.5, energy_kwh: 4240, from: "2026-10-21T01:00:00Z", to: "2026-10-21T10:30:00Z" },
      ],
    });
    expect(prBasisNote(dead, zone, now)?.text).toBe("PR from 0% of the energy · WMS set aside");
  });

  it("dates a span on another day, and one across midnight", () => {
    expect(spanWords("2026-10-19T06:00:00Z", "2026-10-19T14:30:00Z", zone, now)).toBe(
      "19-10 11:30–20:00",
    );
    expect(spanWords("2026-10-20T15:00:00Z", "2026-10-21T02:00:00Z", zone, now)).toBe(
      "20-10 20:30 – 21-10 07:30",
    );
    // Ending on the stroke of midnight is still the day it began.
    expect(spanWords("2026-10-21T12:30:00Z", "2026-10-21T18:30:00Z", zone, now)).toBe(
      "18:00–00:00",
    );
  });

  it("joins with the sunlight note on one line", () => {
    const joined = combineNotes(
      prBasisNote(outage, zone, now),
      { text: "Sunlight from live GHI", title: "Live.", warn: false },
    );
    expect(joined?.text).toBe(
      "PR from 41% of the energy · no sunlight readings 11:30–20:00 · sunlight from live GHI",
    );
    expect(combineNotes(null, null)).toBeNull();
  });

  it("is optional on the KPI response, for an older server", () => {
    const parsed = PlantKpisSchema.safeParse({
      plant_id: 1,
      period: "today",
      energy_kwh: 1,
      performance_ratio: { value: 0.8, variant: "ghi_uncorrected", undefined_reason: null },
      cuf: { value: 0.2, variant: "x", undefined_reason: null },
      availability: { value: 1, variant: "x", undefined_reason: null },
      co2_avoided_kg: { value: 1, variant: "x", undefined_reason: null },
      coverage: null,
      assumptions_note: "",
    });
    expect(parsed.success).toBe(true);
  });
});
