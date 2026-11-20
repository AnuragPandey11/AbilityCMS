/**
 * `grid_monitoring` — the Plant's meters: what crosses its boundary with the
 * grid, phase by phase, now and through the day. The client's reference
 * screen (28 Sep 2026), "MFM / Grid Monitoring".
 *
 * ── Which meter is on top ───────────────────────────────────────────────────
 * The one the Plant's Grid stage reads. `sld.grid.export_power` resolves ABT
 * meter first, then MFM, so the headline is the same instrument the diagram's
 * Grid box quotes — chosen by the slot catalogue, not by this file. A Plant
 * with several meters gets a picker, and every meter not on top gets a card of
 * its own below, titled as the Device is named (the reference's "Main MFM
 * (Grid Incomer)" is a Device's name, not a heading written here).
 *
 * ── Where the figures come from ─────────────────────────────────────────────
 * As on the Weather screen: every Tag the meter reported in the last thirty
 * minutes with the live frame over it, placed by preferred Tag codes, a dash
 * with its reason where there is nothing (`useDeviceReadings`). This filters on
 * the meter Device *Types*, catalogue rows, as Inverter Monitoring filters on
 * `INVERTER` (Guardrail 2).
 *
 * ⚠ **No overall power factor is computed.** These meters publish a power
 * factor per phase; an overall one would be arithmetic nobody has supplied —
 * P/√(P²+Q²) drops distortion and needs a sign convention the client has not
 * stated. A meter that publishes `POWER_FACTOR` shows it; for the rest the
 * tile says it is not reported. A supplied formula would be a row in
 * `DERIVED_TAG_FORMULAS`, and this tile would fill with no change here.
 *
 * Units are the catalogue's (§4.1): an 11 kV feeder's line voltage is in kV,
 * and the reference's power trend in MW is kW here.
 */

import { useMemo, useState } from "react";
import { usePlant, usePlantDevices } from "@/api/hooks";
import type { DeviceListItem } from "@/api/schemas";
import { measuresGeneration, useSlotSource } from "@/api/useSlotTrend";
import type { TrendWindow } from "@/api/trendWindow";
import { Button, Panel, SegmentedControl, SelectBox } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonKpiRow, SkeletonPanel } from "@/components/state";
import { CommStatusPill, PlantPicker } from "@/components/domain";
import { LanedTrendChart } from "@/components/charts/LanedTrendChart";
import { useTrendSelection } from "@/components/charts/useTrendSelection";
import { FigureTile, type Filled, type Position } from "@/components/devices/InverterView";
import { ReadingTile } from "@/components/devices/ReadingTile";
import { useDeviceReadings } from "@/components/devices/useDeviceReadings";
import { TREND_WINDOWS, useDeviceTrends } from "@/components/devices/useDeviceTrends";
import { deviceTrendOption, isReported } from "@/components/devices/trendOption";
import { IconEnergy, IconFrequency, IconGauge, IconPower } from "@/components/icons";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { formatDateTime, timezoneLabel } from "@/format/datetime";

/** The meter Types, in the order the Grid stage's own candidates take them. */
const METER_TYPES = ["ABT_METER", "MFM"];

const LINE_VOLTAGE: Position[] = [
  { label: "R-Y", codes: ["HV_VOLTAGE_RY", "AC_VOLTAGE_RY"] },
  { label: "Y-B", codes: ["HV_VOLTAGE_YB", "AC_VOLTAGE_YB"] },
  { label: "B-R", codes: ["HV_VOLTAGE_BR", "AC_VOLTAGE_BR"] },
];
const PHASE_CURRENT: Position[] = [
  { label: "R", codes: ["AC_CURRENT_R"] },
  { label: "Y", codes: ["AC_CURRENT_Y"] },
  { label: "B", codes: ["AC_CURRENT_B"] },
];
const PHASE_PF: Position[] = [
  { label: "R", codes: ["POWER_FACTOR_R"] },
  { label: "Y", codes: ["POWER_FACTOR_Y"] },
  { label: "B", codes: ["POWER_FACTOR_B"] },
];
const ACTIVE_POWER: Position = { label: "Active power", codes: ["AC_ACTIVE_POWER"] };
const REACTIVE_POWER: Position = { label: "Reactive power", codes: ["AC_REACTIVE_POWER"] };
const FREQUENCY: Position = { label: "Frequency", codes: ["FREQUENCY"] };
const OVERALL_PF: Position = { label: "Overall PF", codes: ["POWER_FACTOR"] };
const EXPORT_ENERGY: Position = { label: "Export energy", codes: ["ENERGY_EXPORT_TOTAL"] };
const IMPORT_ENERGY: Position = { label: "Import energy", codes: ["ENERGY_IMPORT_TOTAL"] };

/** A meter's card: the same figures in the reference's order, each named in full. */
const CARD: Position[] = [
  ...LINE_VOLTAGE.map((position) => ({ ...position, label: `Voltage ${position.label}` })),
  ...PHASE_CURRENT.map((position) => ({ ...position, label: `Current ${position.label}` })),
  ...PHASE_PF.map((position) => ({ ...position, label: `PF ${position.label}` })),
  ACTIVE_POWER,
  REACTIVE_POWER,
  FREQUENCY,
  EXPORT_ENERGY,
  IMPORT_ENERGY,
];

/** ABT meters before MFMs, then MFM_2 before MFM_10 — codes carry numbers. */
const byTypeThenCode = (a: DeviceListItem, b: DeviceListItem) =>
  METER_TYPES.indexOf(a.type_code) - METER_TYPES.indexOf(b.type_code) ||
  a.code.localeCompare(b.code, undefined, { numeric: true });

/**
 * The meter on top: the one somebody chose, else the Type the Grid stage
 * reads, else the first — ABT meter before MFM, the Grid stage's own order.
 * A chosen id not at this Plant (the Plant changed under it) is ignored. A
 * meter on another line than the solar output is never the default: the Grid
 * stage passes it over, and `MAIN_MFM` would otherwise win on its code.
 */
export function headlineMeter(
  devices: DeviceListItem[],
  { chosenId, gridType }: { chosenId: number | null; gridType: string | null },
): DeviceListItem | null {
  const meters = devices.filter((device) => METER_TYPES.includes(device.type_code)).sort(byTypeThenCode);
  const generation = meters.filter(measuresGeneration);
  return (
    meters.find((device) => device.id === chosenId) ??
    generation.find((device) => device.type_code === gridType) ??
    generation[0] ??
    meters[0] ??
    null
  );
}

/** Said beside a meter the Plant's figures pass over. */
const NOT_COUNTED =
  "This meter is on a line other than the Plant's solar output, so the Plant's " +
  "figures (PR, energy, Current Power, the Grid stage, the reports) do not use it. " +
  "Change it under Tag Mapping → Device settings.";

function NotCountedChip({ device }: { device: DeviceListItem }): JSX.Element | null {
  if (measuresGeneration(device)) return null;
  return (
    <span className="rounded border border-line px-1.5 py-0.5 text-xs font-normal text-ink-muted" title={NOT_COUNTED}>
      Not in Plant figures
    </span>
  );
}

/**
 * The Device's name where it says more than its code. Registration names a
 * Device after its code ("Abt Meter" for `ABT_METER`), and printing both reads
 * as a stutter; a name somebody gave it — "Main MFM (Grid Incomer)" — is kept.
 */
export function meterName(device: Pick<DeviceListItem, "name" | "code">): string | null {
  const plain = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");
  return device.name && plain(device.name) !== plain(device.code) ? device.name : null;
}

function PhasePanel({
  title,
  positions,
  fill,
}: {
  title: string;
  positions: Position[];
  fill: (position: Position) => Filled;
}): JSX.Element {
  return (
    <Panel title={<span className="text-base">{title}</span>} padding="p-3">
      <div className="grid grid-cols-3 gap-2">
        {positions.map((position) => (
          <FigureTile key={position.label} filled={fill(position)} />
        ))}
      </div>
    </Panel>
  );
}

/** Every figure of one meter that is not the one on top. */
function MeterCard({
  device,
  timezone,
  onShow,
}: {
  device: DeviceListItem;
  timezone: string | undefined;
  onShow: () => void;
}): JSX.Element {
  const readings = useDeviceReadings(device, "this meter");
  const name = meterName(device);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2 text-base">
          {name ?? <span className="font-mono">{device.code}</span>}
          {name ? <span className="font-mono text-sm font-medium text-ink-muted">{device.code}</span> : null}
          {device.type_code !== device.code ? (
            <span className="text-xs font-normal text-ink-faint">{device.type_code}</span>
          ) : null}
          <NotCountedChip device={device} />
        </span>
      }
      actions={
        <>
          <CommStatusPill status={device.comm_status} />
          {/* The way into this meter's trends: it takes the top of the page. */}
          <Button onClick={onShow}>Show with trends</Button>
        </>
      }
      padding="p-4"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        {CARD.map((position) => (
          <FigureTile key={position.label} filled={readings.fill(position)} />
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        Last updated{" "}
        <span className="figure text-ink-muted">
          {readings.heard ? formatDateTime(readings.heard, timezone) : "never"}
        </span>
      </p>
    </Panel>
  );
}

export function GridMonitoringDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const timezone = plantQuery.data?.timezone;

  const meters = useMemo(
    () =>
      (devicesQuery.data ?? [])
        .filter((device) => METER_TYPES.includes(device.type_code))
        .sort(byTypeThenCode),
    [devicesQuery.data],
  );

  // Which Type the Grid stage reads here — the server's resolution, so a Plant
  // whose ABT meter is registered but unbound falls to its MFM exactly as the
  // diagram does.
  const grid = useSlotSource(plantId, "sld.grid.export_power");
  const gridType = grid.source?.device_type_code ?? null;
  /** `null` means "the Grid stage's meter", so a Plant switch never strands a stale id. */
  const [chosenId, setChosenId] = useState<number | null>(null);
  const headline = headlineMeter(meters, { chosenId, gridType });
  const others = meters.filter((device) => device.id !== headline?.id);

  const readings = useDeviceReadings(headline, "this meter");

  // ── Trends: one chart, every reading the meter on top sends that a line
  // can be drawn for, ticked from a menu. Active power and frequency are
  // drawn to begin with — the two the reference's separate charts showed.
  const [trendWindow, setTrendWindow] = useState<TrendWindow>("today");
  const candidates = [
    { key: "active", position: ACTIVE_POWER, label: "Active power", markPeak: true },
    { key: "frequency", position: FREQUENCY, label: "Frequency", markPeak: false },
    { key: "reactive", position: REACTIVE_POWER, label: "Reactive power", markPeak: false },
    ...LINE_VOLTAGE.map((position) => ({
      key: `v:${position.label}`,
      position,
      label: `Voltage ${position.label}`,
      markPeak: false,
    })),
    ...PHASE_CURRENT.map((position) => ({
      key: `i:${position.label}`,
      position,
      label: `Current ${position.label}`,
      markPeak: false,
    })),
    ...PHASE_PF.map((position) => ({
      key: `pf:${position.label}`,
      position,
      label: `PF ${position.label}`,
      markPeak: false,
    })),
    { key: "overall-pf", position: OVERALL_PF, label: "Overall PF", markPeak: false },
  ]
    .map((entry) => ({ ...entry, filled: readings.fill(entry.position) }))
    // Active power and frequency are always listed (a quiet meter's history is
    // what is wanted in an outage); the rest only where the meter reports or
    // is bound to them — `fill` returns the catalogue's Tag for any of them.
    .filter(
      (entry) =>
        entry.key === "active" ||
        entry.key === "frequency" ||
        isReported(entry.filled, entry.position.codes, readings.bound),
    );
  const selection = useTrendSelection(
    candidates.map((entry) => ({
      key: entry.key,
      unavailableReason: entry.filled.tag ? null : (entry.filled.reason ?? "This meter does not report it."),
    })),
    ["active", "frequency"],
  );
  // Only the ticked readings are fetched, so Today stays at one-minute buckets.
  const trends = useDeviceTrends(
    headline,
    candidates.filter((entry) => selection.selected.has(entry.key)).map((entry) => entry.filled.tag),
    trendWindow,
    timezone,
    readings.tagsById,
  );
  const trendOptions = candidates.map((entry) =>
    deviceTrendOption({
      key: entry.key,
      label: entry.label,
      tag: entry.filled.tag,
      reason: entry.filled.reason,
      trends,
      markPeak: entry.markPeak,
      // The meter on top is the claim: say which Device these come from.
      provenance: headline?.code ?? null,
    }),
  );

  const showOnTop = (device: DeviceListItem) => {
    setChosenId(device.id);
    // Back to the top of the page, as it opens. Scrolling the header into view
    // instead parks the title under the sticky bar, blurred.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const name = headline ? meterName(headline) : null;
  const header = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="page-title">MFM / Grid Monitoring</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {headline ? (
            <>
              <span className={`font-medium text-ink ${name ? "" : "font-mono"}`}>{name ?? headline.code}</span>
              {name ? <span className="font-mono text-ink-faint"> {headline.code}</span> : null}
              {measuresGeneration(headline) ? null : (
                <span className="ml-2 align-middle">
                  <NotCountedChip device={headline} />
                </span>
              )}
              {" · "}Last updated{" "}
              <span className="figure text-ink">
                {readings.heard ? formatDateTime(readings.heard, timezone) : "never"}
              </span>
              {timezone ? <span className="text-ink-faint"> · {timezoneLabel(timezone)} time</span> : null}
            </>
          ) : (
            "The Plant's meters: what crosses its boundary with the grid, phase by phase."
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
        {headline ? <CommStatusPill status={headline.comm_status} /> : null}
        {meters.length > 1 && headline ? (
          <SelectBox
            label="Meter"
            value={String(headline.id)}
            onChange={(next) => setChosenId(Number(next))}
            display={<span className="font-mono">{headline.code}</span>}
          >
            {meters.map((device) => (
              <option key={device.id} value={device.id}>
                {device.code}
                {meterName(device) ? ` — ${meterName(device)}` : ""} ({device.type_code})
              </option>
            ))}
          </SelectBox>
        ) : null}
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
      </div>
    </header>
  );

  if (devicesQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <SkeletonKpiRow tiles={4} />
        <SkeletonPanel />
      </div>
    );
  }
  if (devicesQuery.isError) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState error={devicesQuery.error} retry={() => void devicesQuery.refetch()} />
      </div>
    );
  }
  if (!headline) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {/* Guardrail 26: say which of the two blanks this is. */}
        <EmptyState
          title="No meter at this Plant"
          detail="No Device of type ABT_METER or MFM is registered here, so there is nothing to show — not a meter that has gone quiet. Register one through Plants & Devices."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}

      <div className="grid gap-4 lg:grid-cols-3">
        <PhasePanel title="Voltage" positions={LINE_VOLTAGE} fill={readings.fill} />
        <PhasePanel title="Current" positions={PHASE_CURRENT} fill={readings.fill} />
        <PhasePanel title="Power factor" positions={PHASE_PF} fill={readings.fill} />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <ReadingTile icon={IconPower} label="Active power" filled={readings.fill(ACTIVE_POWER)} />
        <ReadingTile icon={IconPower} label="Reactive power" filled={readings.fill(REACTIVE_POWER)} />
        <ReadingTile icon={IconFrequency} label="Frequency" filled={readings.fill(FREQUENCY)} />
        <ReadingTile icon={IconGauge} label="Overall PF" filled={readings.fill(OVERALL_PF)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ReadingTile icon={IconEnergy} label="Export energy" filled={readings.fill(EXPORT_ENERGY)} />
        <ReadingTile icon={IconEnergy} label="Import energy" filled={readings.fill(IMPORT_ENERGY)} />
      </div>

      {others.map((device) => (
        <MeterCard key={device.id} device={device} timezone={timezone} onShow={() => showOnTop(device)} />
      ))}

      <Panel
        title={<span className="text-base">Meter trends</span>}
        subtitle={
          <span className="text-sm">
            Tick the readings to draw. Readings in one unit share a plot; each other unit gets its own,
            on the same time axis. A break in a line is a stretch in which nothing was received from
            this meter.
          </span>
        }
        actions={
          <SegmentedControl
            label="Meter trend window"
            value={trendWindow}
            onChange={setTrendWindow}
            options={TREND_WINDOWS}
          />
        }
        padding="p-4"
      >
        {trends.isError ? (
          <ErrorState error={trends.error} retry={trends.refetch} />
        ) : (
          <LanedTrendChart
            // Another meter on top starts its menu and zoom afresh.
            key={headline.id}
            options={trendOptions}
            selected={selection.selected}
            onSelectedChange={selection.setSelected}
            from={trends.range ? Date.parse(trends.range.from) : 0}
            to={trends.range ? Date.parse(trends.range.to) : 0}
            day={trends.range?.day ?? null}
            timezone={timezone}
            isLoading={trends.isLoading || trends.range === null}
          />
        )}
      </Panel>
    </div>
  );
}
