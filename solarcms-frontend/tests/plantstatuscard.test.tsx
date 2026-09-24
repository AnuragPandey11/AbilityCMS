/**
 * The Plant Status card — the rows that are rules rather than readings.
 *
 * Each of these is a way the card could state something nobody measured: a
 * start printed as exact when it happened in a silence, "connected" on a Plant
 * with no breaker, "running" on a Plant nobody can hear, or a weather figure
 * on a Plant with no weather station.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OperatingDay, OperatingStatus, ResolvedSlot } from "@/api/schemas";
import { PlantStatusCard } from "@/dashboards/single-plant/PlantStatusCard";

const ZONE = "Asia/Kolkata";

const day = (over: Partial<OperatingDay> = {}): OperatingDay => ({
  date: "2026-09-24",
  start_at: null,
  start_after: null,
  start_observed: false,
  stop_at: null,
  stop_after: null,
  stop_observed: false,
  ended_running: false,
  last_sample_at: null,
  ...over,
});

const status = (over: Partial<OperatingStatus> = {}): OperatingStatus => ({
  plant_id: 1,
  as_of: "2026-09-24T09:00:00Z",
  operating: {
    state: "running",
    undefined_reason: null,
    last_sample_at: "2026-09-24T08:59:00Z",
    source: {
      device_type_code: "INVERTER",
      tag_code: "AC_ACTIVE_POWER",
      aggregate: "sum",
      device_count: 12,
      reporting: 12,
    },
    start_above: 0.5,
    stop_at_or_below: 0,
    unit: "kW",
    resolution: "agg_1m",
    flagged_buckets: 0,
  },
  // 08:25 UTC is 13:55 in Kolkata.
  today: day({
    start_at: "2026-09-24T08:25:00Z",
    start_after: "2026-09-24T08:24:00Z",
    start_observed: true,
    ended_running: true,
  }),
  yesterday: day({
    date: "2026-09-23",
    start_at: "2026-09-23T00:40:00Z",
    start_after: "2026-09-23T00:39:00Z",
    start_observed: true,
    stop_at: "2026-09-23T13:10:00Z",
    stop_after: "2026-09-23T13:09:00Z",
    stop_observed: true,
  }),
  peak: {
    value: 3380.79,
    at: "2026-09-24T14:34:00Z",
    unit: "kW",
    source: { device_type_code: "ABT_METER", tag_code: "AC_ACTIVE_POWER", aggregate: "first", device_count: 1 },
    undefined_reason: null,
  },
  grid: {
    state: "connected",
    breakers: 1,
    reporting: 1,
    closed: 1,
    open: 0,
    undefined_reason: null,
    source: { device_type_code: "VCB", tag_code: "VCB_ON_FEEDBACK" },
  },
  ...over,
});

const irradiance: ResolvedSlot = {
  slot_code: "env.irradiance",
  label: "Irradiance",
  position: 1,
  value: 633.6,
  unit: "W/m2",
  undefined_reason: null,
  source: {
    kind: "device_tag",
    device_type_code: "WMS",
    tag_code: "GTI",
    aggregate: "avg",
    device_count: 1,
    is_aggregated: false,
    degraded: false,
  },
  override_note: null,
} as ResolvedSlot;

const card = (value: OperatingStatus | undefined, environment: ResolvedSlot[] = [irradiance]) =>
  render(
    <PlantStatusCard
      status={value}
      isLoading={false}
      environment={environment}
      devices={[]}
      health={{ online: 19, degraded: 0, offline: 0, unknown: 0 }}
      timeZone={ZONE}
      onOpen={() => {}}
    />,
  );

/** The value cell beside a row's label. */
const valueOf = (label: string) => screen.getByTitle(label).nextElementSibling;

describe("Plant Status card", () => {
  it("shows the reference's rows, in the Plant's time", () => {
    card(status());
    expect(valueOf("Plant Status")).toHaveTextContent("Running");
    expect(valueOf("Grid Status")).toHaveTextContent("Connected");
    expect(valueOf("Irradiance")).toHaveTextContent("633.6");
    expect(valueOf("Plant Start (Today)")).toHaveTextContent("13:55");
    // Running, so the stop shown is yesterday's: 13:10 UTC is 18:40 local.
    expect(valueOf("Plant Stop (Yesterday)")).toHaveTextContent("18:40");
    expect(valueOf("Peak Load (Today)")).toHaveTextContent("3,381");
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("says 'by' when the start happened in a silence", () => {
    card(status({ today: day({ start_at: "2026-09-24T08:25:00Z", ended_running: true }) }));
    expect(valueOf("Plant Start (Today)")).toHaveTextContent("by 13:55");
  });

  it("shows today's stop once the Plant has stopped for the day", () => {
    const stopped = status();
    stopped.operating = { ...stopped.operating, state: "stopped" };
    stopped.today = day({
      start_at: "2026-09-24T01:00:00Z",
      start_after: "2026-09-24T00:59:00Z",
      start_observed: true,
      stop_at: "2026-09-24T13:05:00Z",
      stop_after: "2026-09-24T13:04:00Z",
      stop_observed: true,
    });
    card(stopped);
    expect(valueOf("Plant Stop (Today)")).toHaveTextContent("18:35");
  });

  it("leaves a stop it never saw blank, and says why", () => {
    card(status({ yesterday: day({ date: "2026-09-23", start_at: "2026-09-23T00:40:00Z", ended_running: true, last_sample_at: "2026-09-23T17:43:00Z" }) }));
    const cell = valueOf("Plant Stop (Yesterday)");
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveAttribute("title", expect.stringMatching(/went quiet at 23:13/));
  });

  it("never calls a Plant with no breaker connected", () => {
    card(
      status({
        grid: {
          state: null,
          breakers: 0,
          reporting: 0,
          closed: 0,
          open: 0,
          undefined_reason: "no breaker is registered at this Plant",
          source: { device_type_code: "VCB", tag_code: "VCB_ON_FEEDBACK" },
        },
      }),
    );
    expect(valueOf("Grid Status")).toHaveTextContent("—");
  });

  it("reports a Plant nobody can hear as unknown, not as its last state", () => {
    const silent = status();
    silent.operating = {
      ...silent.operating,
      state: "unknown",
      undefined_reason: "no Inverter has reported since it was last generating",
    };
    card(silent);
    expect(valueOf("Plant Status")).toHaveTextContent("Unknown");
    expect(valueOf("Plant Status")).not.toHaveTextContent("Running");
  });

  it("gives a Plant with no weather station a reason, not a zero", () => {
    card(status(), []);
    const cell = valueOf("Cloud Cover");
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveAttribute("title", expect.stringMatching(/no weather station/));
  });
});
