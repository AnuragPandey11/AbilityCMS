/**
 * `meteorological` — the Weather Station: what it reads now, and how that
 * moved. The client's reference screen (28 Sep 2026).
 *
 * Top to bottom: nine instantaneous figures, four accumulated or averaged
 * ones, then one full-width trend over a chosen window, with a menu of every
 * reading the station sends — GHI, GTI, ambient and module temperature, wind
 * speed drawn to begin with (what four separate charts drew before). Readings
 * beyond those five are listed only where the station reports or is bound to
 * them.
 *
 * ── Where the figures come from ─────────────────────────────────────────────
 * The same way the Inverter view builds its screen (`InverterView`): every Tag
 * the station *reported* in the last thirty minutes, with the live frame over
 * it, placed by catalogue Tag codes in order of preference. A signal nothing
 * here places is listed under "Other signals" rather than dropped. Positions
 * name Tags, never a Client, Plant or Device (Guardrail 2), and this screen
 * filters on the `WMS` Device *Type*, a catalogue row, the way Inverter
 * Monitoring filters on `INVERTER`.
 *
 * ⚠ Two of the reference's four "accumulated" cards are not accumulations
 * here. Its `DIFA` and `DA` are the client's keys for **diffuse and direct
 * radiation average** (`SOURCE_KEY_ALIASES`), which their own schedule lists
 * in W/m² (TAG_CATALOGUE §2.2) — so they are labelled and unitted as that
 * says, not as kWh/m² totals. The catalogue is authoritative on units.
 *
 * One chart, plots by unit (Guardrail 22): GHI and GTI share a W/m² plot,
 * ambient and module temperature a °C plot, wind speed its own, all on one
 * time axis with one zoom and one crosshair (`LanedTrendChart`). Gaps stay
 * gaps (Guardrail 23) and flagged readings are counted, never drawn. Only the
 * ticked readings are fetched, so Today stays at one-minute buckets for up to
 * twelve of them; past that the tier badge says it has coarsened.
 */

import { useMemo, useState } from "react";
import { usePlant, usePlantDevices } from "@/api/hooks";
import type { DeviceListItem } from "@/api/schemas";
import type { TrendWindow } from "@/api/trendWindow";
import { Panel, SegmentedControl, SelectBox } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonKpiRow, SkeletonPanel } from "@/components/state";
import { CommStatusPill, PlantPicker } from "@/components/domain";
import { LanedTrendChart } from "@/components/charts/LanedTrendChart";
import { useTrendSelection } from "@/components/charts/useTrendSelection";
import { FigureTile, type Filled, type Position } from "@/components/devices/InverterView";
import { ReadingTile } from "@/components/devices/ReadingTile";
import { useDeviceReadings } from "@/components/devices/useDeviceReadings";
import { TREND_WINDOWS, useDeviceTrends } from "@/components/devices/useDeviceTrends";
import { deviceTrendOption, isReported } from "@/components/devices/trendOption";
import type { IconComponent } from "@/components/layout/navigation";
import {
  IconBeam,
  IconCloud,
  IconCompass,
  IconDiffuse,
  IconEnergy,
  IconIrradianceHorizontal,
  IconIrradianceTilted,
  IconThermometer,
  IconWind,
} from "@/components/icons";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { formatDateTime, timezoneLabel } from "@/format/datetime";

const WMS_TYPE_CODE = "WMS";

interface WeatherPosition extends Position {
  icon: IconComponent;
}

/** What the station reads right now. */
const NOW: WeatherPosition[] = [
  { label: "GHI", codes: ["GHI"], icon: IconIrradianceHorizontal },
  // Plane-of-array under either name, as `env.irradiance` resolves it.
  { label: "GTI", codes: ["GTI", "POA_IRRADIANCE"], icon: IconIrradianceTilted },
  { label: "Wind speed", codes: ["WIND_SPEED"], icon: IconWind },
  { label: "Wind direction", codes: ["WIND_DIRECTION"], icon: IconCompass },
  { label: "Ambient temp.", codes: ["AMBIENT_TEMPERATURE"], icon: IconThermometer },
  { label: "Module temp.", codes: ["MODULE_TEMPERATURE"], icon: IconThermometer },
  { label: "Diffuse radiation", codes: ["DIFFUSE_RADIATION"], icon: IconDiffuse },
  { label: "Direct radiation", codes: ["DIRECT_RADIATION"], icon: IconBeam },
  { label: "Cloud cover", codes: ["CLOUD_COVER"], icon: IconCloud },
];

/** The day's insolation so far, and the two radiation averages (see the file note). */
const SUMMARY: WeatherPosition[] = [
  { label: "Accumulated GHI", codes: ["GHI_CUMULATIVE"], icon: IconEnergy },
  { label: "Accumulated GTI", codes: ["GTI_CUMULATIVE"], icon: IconEnergy },
  { label: "Diffuse radiation, average", codes: ["DIFFUSE_RADIATION_AVG"], icon: IconDiffuse },
  { label: "Direct radiation, average", codes: ["DIRECT_RADIATION_AVG"], icon: IconBeam },
];

const [GHI, GTI, WIND_SPEED, , AMBIENT, MODULE] = NOW as [
  WeatherPosition,
  WeatherPosition,
  WeatherPosition,
  WeatherPosition,
  WeatherPosition,
  WeatherPosition,
];

/** INVERTER_2 before INVERTER_10 — codes carry numbers, and people count. */
const byCode = (a: DeviceListItem, b: DeviceListItem) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

export function MeteorologicalDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);

  const stations = useMemo(
    () => (devicesQuery.data ?? []).filter((device) => device.type_code === WMS_TYPE_CODE).sort(byCode),
    [devicesQuery.data],
  );
  /** The station on screen. `null` means "the first", so a Plant switch never strands a stale id. */
  const [chosenId, setChosenId] = useState<number | null>(null);
  const station = stations.find((device) => device.id === chosenId) ?? stations[0] ?? null;

  const { values, fill, heard, tagsById, bound } = useDeviceReadings(station, "this station");

  const now = NOW.map(fill);
  const summary = SUMMARY.map(fill);

  const placed = new Set(
    [...now, ...summary].map((filled) => filled.tag?.id).filter((id): id is number => id !== undefined),
  );
  const others: Filled[] = [...values.entries()]
    .filter(([tagId]) => !placed.has(tagId))
    .map(([tagId, value]) => {
      const tag = tagsById.get(tagId);
      return { label: tag?.name ?? `Tag ${tagId}`, tag, value, reason: null };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // ── Trends
  const [trendWindow, setTrendWindow] = useState<TrendWindow>("today");
  const timezone = plantQuery.data?.timezone;

  // Every reading the station sends that a line can be drawn for: the five
  // the four old charts drew first, then the rest of its schedule, then
  // anything else it reported. A reading the station does not send is listed
  // (disabled, with the reason) only for the five; for the rest it would be a
  // dozen greyed lines nobody asked about.
  const candidates = (() => {
    const core: { key: string; label: string; filled: Filled; markPeak: boolean }[] = [
      { key: "ghi", label: "GHI", filled: fill(GHI), markPeak: true },
      { key: "gti", label: "GTI", filled: fill(GTI), markPeak: true },
      { key: "ambient", label: "Ambient temperature", filled: fill(AMBIENT), markPeak: false },
      { key: "module", label: "Module temperature", filled: fill(MODULE), markPeak: false },
      // The strongest gust is what a tracker stows for.
      { key: "wind", label: "Wind speed", filled: fill(WIND_SPEED), markPeak: true },
    ];
    const taken = new Set(core.map((entry) => entry.filled.tag?.id).filter((id): id is number => id !== undefined));
    const more: typeof core = [];
    for (const position of [...NOW, ...SUMMARY]) {
      const filled = fill(position);
      // `fill` hands back the catalogue's Tag even for a signal the station
      // has nothing to do with; list it only where it reported or is bound.
      if (!filled.tag || taken.has(filled.tag.id) || !isReported(filled, position.codes, bound)) continue;
      taken.add(filled.tag.id);
      more.push({ key: `tag:${filled.tag.id}`, label: position.label, filled, markPeak: false });
    }
    for (const filled of others) {
      if (!filled.tag || taken.has(filled.tag.id)) continue;
      taken.add(filled.tag.id);
      more.push({ key: `tag:${filled.tag.id}`, label: filled.label, filled, markPeak: false });
    }
    return [...core, ...more];
  })();

  const selection = useTrendSelection(
    candidates.map((entry) => ({
      key: entry.key,
      unavailableReason: entry.filled.tag ? null : (entry.filled.reason ?? "The station does not report this."),
    })),
    ["ghi", "gti", "ambient", "module", "wind"],
  );
  // Only what is ticked is asked for: `tierWithin` spends one point budget on
  // every Tag, and a whole station's worth would push Today off one-minute.
  const trends = useDeviceTrends(
    station,
    candidates.filter((entry) => selection.selected.has(entry.key)).map((entry) => entry.filled.tag),
    trendWindow,
    timezone,
    tagsById,
  );
  const range = trends.range;
  const trendOptions = candidates.map((entry) =>
    deviceTrendOption({
      key: entry.key,
      label: entry.label,
      tag: entry.filled.tag,
      reason: entry.filled.reason,
      trends,
      markPeak: entry.markPeak,
    }),
  );

  // ── Rendering
  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const header = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="page-title">Meteorological / Weather Station</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {station ? (
            <>
              {/* The later of what the health sweep last heard and the last live
                  frame — both are the station speaking. */}
              Last updated{" "}
              <span className="figure text-ink">{heard ? formatDateTime(heard, timezone) : "never"}</span>
              {timezone ? <span className="text-ink-faint"> · {timezoneLabel(timezone)} time</span> : null}
            </>
          ) : (
            "The Plant's Weather Station: irradiance, temperature and wind, now and over time."
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
        {station ? <CommStatusPill status={station.comm_status} /> : null}
        {stations.length > 1 && station ? (
          <SelectBox
            label="Station"
            value={String(station.id)}
            onChange={(next) => setChosenId(Number(next))}
            display={<span className="font-mono">{station.code}</span>}
          >
            {stations.map((device) => (
              <option key={device.id} value={device.id}>
                {device.code}
                {device.name && device.name !== device.code ? ` — ${device.name}` : ""}
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
        <SkeletonKpiRow tiles={5} />
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
  if (!station) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {/* Guardrail 26: say which of the two blanks this is. */}
        <EmptyState
          title="No Weather Station at this Plant"
          detail="No Device of type WMS is registered here, so there is nothing to show — not a station that has gone quiet. Register one through Plants & Devices; a rooftop Plant often has none, and that is normal."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* Nine readings divide evenly only as 3 × 3 or 9 × 1; any other count
          of columns leaves a short last row. One row once each tile has room
          for a figure like "730.2 W/m2" (~113px at 1400px with the sidebar). */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 min-[1400px]:grid-cols-9">
        {NOW.map((position, index) => (
          <ReadingTile key={position.label} icon={position.icon} label={position.label} filled={now[index] as Filled} />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {SUMMARY.map((position, index) => (
          <ReadingTile key={position.label} icon={position.icon} label={position.label} filled={summary[index] as Filled} />
        ))}
      </div>

      <Panel
        title={<span className="text-base">Weather trends</span>}
        subtitle={
          <span className="text-sm">
            A break in a line is a stretch in which nothing was received from the station — not a
            reading of zero, and never drawn as one.
          </span>
        }
        actions={
          <SegmentedControl
            label="Weather trend window"
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
            // A station switch starts its menu and zoom afresh.
            key={station.id}
            options={trendOptions}
            selected={selection.selected}
            onSelectedChange={selection.setSelected}
            from={range ? Date.parse(range.from) : 0}
            to={range ? Date.parse(range.to) : 0}
            day={range?.day ?? null}
            timezone={timezone}
            isLoading={trends.isLoading || range === null}
          />
        )}
      </Panel>

      {/* Rendered only when there are any: a section that says "nothing else"
          on every station is one people stop reading. */}
      {others.length > 0 ? (
        <details className="group rounded-card border border-line bg-surface-raised">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-ink">
            Other signals this station reported
            <span className="ml-2 font-normal text-ink-muted">{others.length}</span>
          </summary>
          <div className="grid grid-cols-2 gap-3 border-t border-line p-4 sm:grid-cols-3 lg:grid-cols-5">
            {others.map((filled) => (
              <FigureTile key={filled.label} filled={filled} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
