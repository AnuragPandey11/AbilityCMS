/**
 * `energy_analytics` — the Plant's history over a window you choose. The
 * client's reference screen (28 Sep 2026).
 *
 * Four trends on one window — Plant power, GHI, module temperature, one
 * Inverter's efficiency — and energy per day for the last thirty days. The
 * window is a preset or two Plant-local wall times typed by hand.
 *
 * ── Where each curve comes from ─────────────────────────────────────────────
 * - **Plant power** and **module temperature** read their dashboard slots
 *   (`kpi.current_power`, `env.module_temperature`) exactly as the Single Plant
 *   screen does, so each is the same claim as the figure there — the meter on
 *   one Plant, the sum of its Inverters on another — with its provenance
 *   printed under the chart.
 * - **GHI** has no slot of its own (`env.irradiance` prefers the tilted plane),
 *   so it is the Weather Stations' `GHI`, averaged across them if a Plant has
 *   more than one.
 * - **Inverter efficiency** is one Inverter, chosen here. The reference names
 *   "Inverter 1"; a code path named after a Device is what Guardrail 2
 *   forbids, so the screen offers every Inverter and starts on the first.
 * - **Energy per day** is `kpi.energy_today` through `useSlotSteps`, the code
 *   the Single Plant screen's bars use, so the two cannot disagree about a day.
 *
 * Units are the catalogue's, never converted: the reference draws power in MW,
 * and this draws it in whatever unit the resolved Tag carries (§4.1).
 */

import { useMemo, useState } from "react";
import { usePlant, usePlantDevices, useTags } from "@/api/hooks";
import type { DeviceListItem, Tag } from "@/api/schemas";
import { useSeries, useSlotSeries, type Series } from "@/api/useSeries";
import { useSlotSteps } from "@/api/useSlotSteps";
import type { TrendPoint } from "@/api/useSlotTrend";
import { customRange, windowRange, type TrendWindow, type WindowRange } from "@/api/trendWindow";
import { Panel, SegmentedControl, SelectBox, inputClass } from "@/components/ui";
import { EmptyState, ErrorState } from "@/components/state";
import { PlantPicker } from "@/components/domain";
import { TrendChart } from "@/components/charts/TrendChart";
import { NOT_A_UNIT } from "@/components/devices/InverterView";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { fromDateTimeInput, timezoneLabel, toDateTimeInput } from "@/format/datetime";

const WMS_TYPE_CODE = "WMS";
const INVERTER_TYPE_CODE = "INVERTER";
const DAILY_ENERGY_DAYS = 30;

const WINDOWS: { value: TrendWindow; label: string; hint: string }[] = [
  { value: "today", label: "Today", hint: "The Plant's day so far, midnight to midnight." },
  { value: "yesterday", label: "Yesterday", hint: "The Plant's previous day." },
  { value: "7d", label: "Last 7 days", hint: "The last seven days, ending now." },
  { value: "30d", label: "Last 30 days", hint: "The last thirty days, ending now." },
];

type Applied = { kind: "preset"; window: TrendWindow } | { kind: "custom"; from: number; to: number };

/** INVERTER_2 before INVERTER_10 — codes carry numbers, and people count. */
const byCode = (a: DeviceListItem, b: DeviceListItem) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

const unitOf = (unit: string | null | undefined): string | null =>
  unit && !NOT_A_UNIT.has(unit) ? unit : null;

const titled = (label: string, unit: string | null) => (
  <span className="text-base">
    {label}
    {unit ? <span className="font-normal text-ink-muted"> ({unit})</span> : null}
  </span>
);

/** A chart, or the reason there is none — never an empty frame (Guardrail 26). */
function SeriesChart({
  series,
  unavailableReason,
  unit,
  label,
  provenance,
  timezone,
  day,
  markPeak,
}: {
  series: Series;
  unavailableReason: string | null;
  unit: string | null;
  label: string;
  provenance?: string | null;
  timezone: string | undefined;
  day: WindowRange["day"];
  markPeak: boolean;
}): JSX.Element {
  if (unavailableReason) {
    return (
      <p key="unavailable" className="flex h-[260px] items-center justify-center px-6 text-center text-xs text-ink-faint">
        {unavailableReason}
      </p>
    );
  }
  if (series.isError) {
    return (
      <p key="error" className="flex h-[260px] items-center justify-center px-6 text-center text-xs text-bad">
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

export function EnergyAnalyticsDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();
  const timezone = plantQuery.data?.timezone;

  // ── The window
  const [applied, setApplied] = useState<Applied>({ kind: "preset", window: "today" });
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  /** Typed wall times, read in the Plant's zone. Applied as soon as both make a window. */
  const draft = useMemo(() => {
    if (!fromInput || !toInput || !timezone) return null;
    return customRange(fromDateTimeInput(fromInput, timezone), fromDateTimeInput(toInput, timezone), nowMs);
  }, [fromInput, toInput, timezone, nowMs]);
  const draftError = draft && "error" in draft ? draft.error : null;

  const applyDraft = (from: string, to: string) => {
    if (!from || !to || !timezone) return;
    const fromMs = fromDateTimeInput(from, timezone);
    const toMs = fromDateTimeInput(to, timezone);
    if ("error" in customRange(fromMs, toMs, nowMs)) return;
    setApplied({ kind: "custom", from: fromMs, to: toMs });
  };
  const onFrom = (value: string) => {
    setFromInput(value);
    applyDraft(value, toInput);
  };
  const onTo = (value: string) => {
    setToInput(value);
    applyDraft(fromInput, value);
  };
  const onPreset = (window: TrendWindow) => {
    setApplied({ kind: "preset", window });
    // The typed window is no longer what the charts show; leaving it in the
    // boxes would say it was.
    setFromInput("");
    setToInput("");
  };

  // Waits for the Plant's zone: "today" on the browser's day first would be a
  // request answering a question nobody asked.
  const range: WindowRange | null = useMemo(() => {
    if (!timezone) return null;
    if (applied.kind === "preset") return windowRange(applied.window, nowMs, timezone);
    const custom = customRange(applied.from, applied.to, nowMs);
    return "error" in custom ? null : custom;
  }, [applied, nowMs, timezone]);
  // Only a window that ends now has anything new to learn.
  const live = range !== null && Date.parse(range.to) >= nowMs;

  // ── The series
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const tagsByCode = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.code, tag])),
    [tagsQuery.data],
  );

  const power = useSlotSeries(plantId, "kpi.current_power", range, { live });
  const moduleTemperature = useSlotSeries(plantId, "env.module_temperature", range, { live });

  const stations = useMemo(() => devices.filter((device) => device.type_code === WMS_TYPE_CODE), [devices]);
  const ghiTag = tagsByCode.get("GHI");
  const ghi = useSeries({ devices: stations, tag: ghiTag, aggregate: "avg" }, range, { live });

  const inverters = useMemo(
    () => devices.filter((device) => device.type_code === INVERTER_TYPE_CODE).sort(byCode),
    [devices],
  );
  /** `null` means "the first", so a Plant switch never strands a stale id. */
  const [inverterId, setInverterId] = useState<number | null>(null);
  const inverter = inverters.find((device) => device.id === inverterId) ?? inverters[0] ?? null;
  const oneInverter = useMemo(() => (inverter ? [inverter] : []), [inverter]);
  const efficiencyTag = tagsByCode.get("INVERTER_EFFICIENCY");
  const efficiency = useSeries({ devices: oneInverter, tag: efficiencyTag, aggregate: "first" }, range, {
    live,
  });

  const energyDays = useSlotSteps(plantId, "kpi.energy_today", { days: DAILY_ENERGY_DAYS }, { resetsExpected: true });
  const energyPoints = useMemo<TrendPoint[]>(
    () =>
      energyDays.periods.map((day) => ({
        at: new Date(day.start).toISOString(),
        value: day.energy,
        contributors: day.contributors,
      })),
    [energyDays.periods],
  );

  /** Why a Type-and-Tag series cannot be drawn, before anything is asked. */
  const missing = (found: DeviceListItem[], typeLabel: string, tag: Tag | undefined, tagCode: string) => {
    if (devicesQuery.isLoading || tagsQuery.isLoading) return null;
    if (found.length === 0) return `No ${typeLabel} is registered at this Plant.`;
    if (!tag) return `Tag ${tagCode} is not in the catalogue.`;
    return null;
  };

  // Module temperature is a Weather Station figure: where there is none, say
  // that rather than the slot's generic absence (Guardrail 26).
  const noStation = !devicesQuery.isLoading && devicesQuery.data !== undefined && stations.length === 0;
  const moduleReason = noStation
    ? "No Weather Station (WMS) is registered at this Plant."
    : moduleTemperature.unavailableReason;

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const day = range?.day ?? null;
  // The native picker offers nothing past now, in the Plant's own clock.
  const latestInput = timezone ? toDateTimeInput(nowMs, timezone) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Energy Analytics</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Historical trends over a window you choose
            {timezone ? `, in the Plant's time (${timezoneLabel(timezone)})` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
        </div>
      </header>

      {/* One window for all four trends: a per-chart control would let two
          charts sit side by side on different spans and still look aligned. */}
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl<TrendWindow | "custom">
          label="Analytics window"
          size="lg"
          // A custom window highlights no preset — none of them is on screen.
          value={applied.kind === "preset" ? applied.window : "custom"}
          onChange={(value) => {
            if (value !== "custom") onPreset(value);
          }}
          options={WINDOWS}
        />
        <label className="flex flex-col gap-1">
          <span className="field-label">From</span>
          <input
            type="datetime-local"
            value={fromInput}
            max={latestInput}
            onChange={(event) => onFrom(event.target.value)}
            className={`${inputClass} w-auto`}
            aria-describedby="analytics-window-note"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="field-label">To</span>
          <input
            type="datetime-local"
            value={toInput}
            max={latestInput}
            onChange={(event) => onTo(event.target.value)}
            className={`${inputClass} w-auto`}
            aria-describedby="analytics-window-note"
          />
        </label>
        <p id="analytics-window-note" className={`pb-2 text-xs ${draftError ? "text-bad" : "text-ink-faint"}`}>
          {draftError ??
            (applied.kind === "custom"
              ? "Showing the window typed. Pick a preset to go back."
              : "Type a start and an end to show any other window.")}
        </p>
      </div>

      {plantQuery.isError ? (
        <ErrorState error={plantQuery.error} retry={() => void plantQuery.refetch()} />
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={titled("Plant power", unitOf(power.unit))} padding="p-4">
          <SeriesChart
            series={power}
            unavailableReason={power.unavailableReason}
            unit={unitOf(power.unit)}
            label="Plant power"
            provenance={power.provenance}
            timezone={timezone}
            day={day}
            markPeak
          />
        </Panel>

        <Panel title={titled("Irradiance GHI", unitOf(ghiTag?.unit))} padding="p-4">
          <SeriesChart
            series={ghi}
            unavailableReason={missing(stations, "Weather Station (WMS)", ghiTag, "GHI")}
            unit={unitOf(ghiTag?.unit)}
            label="GHI"
            provenance={
              stations.length > 1 ? `avg of ${stations.length} WMS` : stations.length === 1 ? "WMS" : null
            }
            timezone={timezone}
            day={day}
            markPeak
          />
        </Panel>

        <Panel title={titled("Module temperature", unitOf(moduleTemperature.unit))} padding="p-4">
          <SeriesChart
            series={moduleTemperature}
            unavailableReason={moduleReason}
            unit={unitOf(moduleTemperature.unit)}
            label="Module temperature"
            provenance={moduleTemperature.provenance}
            timezone={timezone}
            day={day}
            // The hottest minute is just the largest number here.
            markPeak={false}
          />
        </Panel>

        <Panel
          title={titled(
            inverter ? `${inverter.code} efficiency` : "Inverter efficiency",
            unitOf(efficiencyTag?.unit),
          )}
          actions={
            inverters.length > 1 && inverter ? (
              <SelectBox
                label="Inverter"
                value={String(inverter.id)}
                onChange={(next) => setInverterId(Number(next))}
                display={<span className="font-mono">{inverter.code}</span>}
              >
                {inverters.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.code}
                    {device.name && device.name !== device.code ? ` — ${device.name}` : ""}
                  </option>
                ))}
              </SelectBox>
            ) : null
          }
          padding="p-4"
        >
          <SeriesChart
            series={efficiency}
            unavailableReason={missing(oneInverter, "Inverter", efficiencyTag, "INVERTER_EFFICIENCY")}
            unit={unitOf(efficiencyTag?.unit)}
            label="Efficiency"
            timezone={timezone}
            day={day}
            markPeak={false}
          />
        </Panel>
      </div>

      <Panel
        title={titled(`Daily energy — last ${DAILY_ENERGY_DAYS} days`, unitOf(energyDays.unit))}
        subtitle="One bar per Plant day, midnight to midnight: what each Device's counter added that day. A day nothing measured is left empty, not drawn as zero. Always the last thirty days, whatever the window above."
        padding="p-4"
      >
        {energyDays.unavailableReason || energyDays.isError ? (
          <p className="py-8 text-center text-xs text-ink-faint">
            {energyDays.unavailableReason ?? "The daily energy could not be loaded."}
          </p>
        ) : (
          <TrendChart
            points={energyPoints}
            unit={energyDays.unit}
            label="Energy"
            // One point per Plant day, so dates format as days; the badge says
            // where the days came from rather than naming this tier.
            tier="agg_1d"
            resolution={{
              label: "Plant days, from hourly readings",
              title:
                "Each bar is the energy every Device's counter added between two of the Plant's midnights, " +
                "summed. Built from hourly buckets because the daily tier is cut at UTC midnight, not the Plant's.",
            }}
            provenance={energyDays.provenance}
            flaggedCount={energyDays.flaggedCount}
            isLoading={energyDays.isLoading}
            timezone={timezone}
            height={300}
            shape="bar"
            markPeak={false}
          />
        )}
      </Panel>
    </div>
  );
}
