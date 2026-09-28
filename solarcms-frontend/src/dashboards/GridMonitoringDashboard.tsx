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
import { usePlant, usePlantDevices, useTags } from "@/api/hooks";
import type { DeviceListItem } from "@/api/schemas";
import { useSlotSource } from "@/api/useSlotTrend";
import { useSeries, type Series } from "@/api/useSeries";
import { windowRange } from "@/api/trendWindow";
import { Button, Panel, SelectBox } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonKpiRow, SkeletonPanel } from "@/components/state";
import { CommStatusPill, PlantPicker } from "@/components/domain";
import { TrendChart } from "@/components/charts/TrendChart";
import { FigureTile, NOT_A_UNIT, type Filled, type Position } from "@/components/devices/InverterView";
import { ReadingTile } from "@/components/devices/ReadingTile";
import { useDeviceReadings } from "@/components/devices/useDeviceReadings";
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
 * A chosen id not at this Plant (the Plant changed under it) is ignored.
 */
export function headlineMeter(
  devices: DeviceListItem[],
  { chosenId, gridType }: { chosenId: number | null; gridType: string | null },
): DeviceListItem | null {
  const meters = devices.filter((device) => METER_TYPES.includes(device.type_code)).sort(byTypeThenCode);
  return (
    meters.find((device) => device.id === chosenId) ??
    meters.find((device) => device.type_code === gridType) ??
    meters[0] ??
    null
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

const unitOf = (unit: string | null | undefined): string | null =>
  unit && !NOT_A_UNIT.has(unit) ? unit : null;

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

/** A trend, or the reason there is none — never an empty frame (Guardrail 26). */
function MeterTrend({
  series,
  unit,
  label,
  reason,
  provenance,
  timezone,
  day,
  markPeak,
}: {
  series: Series;
  unit: string | null;
  label: string;
  reason: string | null;
  provenance: string | null;
  timezone: string | undefined;
  day: { start: number; end: number } | null;
  markPeak: boolean;
}): JSX.Element {
  if (reason) {
    return <p className="flex h-[260px] items-center justify-center px-6 text-center text-xs text-ink-faint">{reason}</p>;
  }
  if (series.isError) {
    return (
      <p className="flex h-[260px] items-center justify-center px-6 text-center text-xs text-bad">
        These readings could not be loaded.
      </p>
    );
  }
  return (
    <TrendChart
      points={series.points}
      unit={unit}
      label={label}
      tier={series.tier}
      provenance={provenance}
      flaggedCount={series.flaggedCount}
      isLoading={series.isLoading}
      timezone={timezone}
      height={260}
      day={day}
      markPeak={markPeak}
    />
  );
}

export function GridMonitoringDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();
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

  // ── Trends: the Plant's day, as the reference draws them.
  const tagsByCode = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.code, tag])),
    [tagsQuery.data],
  );
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const range = timezone ? windowRange("today", nowMs, timezone) : null;
  const onTop = useMemo(() => (headline ? [headline] : []), [headline]);
  const activeTag = tagsByCode.get(ACTIVE_POWER.codes[0] ?? "");
  const frequencyTag = tagsByCode.get(FREQUENCY.codes[0] ?? "");
  const power = useSeries({ devices: onTop, tag: activeTag, aggregate: "first" }, range, { live: true });
  const frequency = useSeries({ devices: onTop, tag: frequencyTag, aggregate: "first" }, range, {
    live: true,
  });
  const catalogueReason = (code: string, found: unknown) =>
    tagsQuery.isLoading || found ? null : `Tag ${code} is not in the catalogue.`;

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

  const day = range?.day ?? null;

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

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title={
            <span className="text-base">
              Active power trend
              {unitOf(activeTag?.unit) ? (
                <span className="font-normal text-ink-muted"> ({unitOf(activeTag?.unit)})</span>
              ) : null}
            </span>
          }
          padding="p-4"
        >
          <MeterTrend
            series={power}
            unit={unitOf(activeTag?.unit)}
            label="Active power"
            reason={catalogueReason("AC_ACTIVE_POWER", activeTag)}
            provenance={headline.code}
            timezone={timezone}
            day={day}
            markPeak
          />
        </Panel>
        <Panel
          title={
            <span className="text-base">
              Frequency trend
              {unitOf(frequencyTag?.unit) ? (
                <span className="font-normal text-ink-muted"> ({unitOf(frequencyTag?.unit)})</span>
              ) : null}
            </span>
          }
          padding="p-4"
        >
          <MeterTrend
            series={frequency}
            unit={unitOf(frequencyTag?.unit)}
            label="Frequency"
            reason={catalogueReason("FREQUENCY", frequencyTag)}
            provenance={headline.code}
            timezone={timezone}
            day={day}
            // The highest instant of grid frequency is not a fact anyone acts on.
            markPeak={false}
          />
        </Panel>
      </div>
    </div>
  );
}
