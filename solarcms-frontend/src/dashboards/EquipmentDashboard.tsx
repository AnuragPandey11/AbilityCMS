/**
 * `transformer_monitoring`, `ppc_monitoring`, `vcb_monitoring` — the Plant's
 * HV equipment, one Device Type per screen. The client's reference screens
 * (30 Sep 2026): "Power Transformer", "Power Plant Controller", "Vacuum
 * Circuit Breaker".
 *
 * One screen, three specs (`equipment/specs.ts`): the headline figures, a
 * panel of contacts, and trends over the history screens' shared period. The VCB has no analogue
 * value, so its screen is contacts only, and it shows every breaker at once.
 *
 * ── Where the figures come from ─────────────────────────────────────────────
 * As on the Weather and meter screens: every Tag the Device reported in the
 * last thirty minutes with the live frame over it, placed by Tag code, a dash
 * with its reason where there is nothing (`useDeviceReadings`), and anything
 * reported but not placed listed under "Other signals" rather than dropped.
 *
 * ── Why a TRUE is not red ───────────────────────────────────────────────────
 * The reference paints every TRUE red and every FALSE green, which calls a
 * closed breaker a fault and a failed trip coil healthy. A contact is marked
 * here only where an open Alarm names it — the Alarm Rules' verdict, not this
 * file's (`equipment/flags.ts`).
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAlarms, usePlant, usePlantDevices } from "@/api/hooks";
import type { Alarm, DeviceListItem, Tag } from "@/api/schemas";
import { useDashboard } from "@/auth/useDashboard";
import { InfoHint, Panel, SelectBox } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonKpiRow, SkeletonPanel } from "@/components/state";
import { CommStatusPill, PlantPicker, SeverityBadge } from "@/components/domain";
import { TrendChart } from "@/components/charts/TrendChart";
import { OverlayTrendChart } from "@/components/charts/OverlayTrendChart";
import { StateTrendChart } from "@/components/charts/StateTrendChart";
import { FigureTile, NOT_A_UNIT, type Filled, type Position } from "@/components/devices/InverterView";
import { ReadingTile } from "@/components/devices/ReadingTile";
import { useDeviceReadings, type DeviceReadings } from "@/components/devices/useDeviceReadings";
import { useDeviceTrends } from "@/components/devices/useDeviceTrends";
import { HistoryPeriodBar } from "@/components/history/HistoryPeriodBar";
import { useHistoryPeriod } from "@/state/useHistoryPeriod";
import { periodDates } from "@/api/historyPeriod";
import { useTimelineEvents } from "@/api/useHistory";
import { exportStem } from "@/components/charts/csv";
import { usePermission } from "@/auth/usePermission";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { formatDateTime, timezoneLabel } from "@/format/datetime";
import { flagState, openAlarmsByTag, type FlagState, type FlagTone } from "./equipment/flags";
import {
  PPC,
  TRANSFORMER,
  VCB,
  type EquipmentSpec,
  type FigureSpec,
  type TrendSpec,
  type VersusSpec,
} from "./equipment/specs";
import { useSlotSeries } from "@/api/useSeries";
import { TIERS, type Tier } from "@/api/schemas";
import type { WindowRange } from "@/api/trendWindow";
import type { TrendSeries } from "@/components/devices/useDeviceTrends";
import { stateSeries } from "./equipment/stateSeries";

/** INVERTER_2 before INVERTER_10 — codes carry numbers, and people count. */
const byTypeThenCode = (types: string[]) => (a: DeviceListItem, b: DeviceListItem) =>
  types.indexOf(a.type_code) - types.indexOf(b.type_code) ||
  a.code.localeCompare(b.code, undefined, { numeric: true });

const unitOf = (tag: Tag | undefined): string | null =>
  tag?.unit && !NOT_A_UNIT.has(tag.unit) ? tag.unit : null;

/** The Device's name where it says more than its code ("Vcb" for `VCB` does not). */
function deviceName(device: Pick<DeviceListItem, "name" | "code">): string | null {
  const plain = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");
  return device.name && plain(device.name) !== plain(device.code) ? device.name : null;
}

/**
 * Whether a figure has a place on this Device's screen: always, unless it is
 * a variant's optional signal the Device neither reports nor is bound to.
 */
export function figureShown(figure: FigureSpec, filled: Filled, bound: Set<string> | null): boolean {
  if (!figure.optional) return true;
  return filled.value !== null || (bound !== null && figure.codes.some((code) => bound.has(code)));
}

/**
 * Reported Tags no position places, named and sorted, so a signal nobody
 * designed a tile for is still on the screen about its Device.
 */
function otherSignals(readings: DeviceReadings, placed: Filled[]): Filled[] {
  const ids = new Set(placed.map((filled) => filled.tag?.id).filter((id): id is number => id !== undefined));
  return [...readings.values.entries()]
    .filter(([tagId]) => !ids.has(tagId))
    .map(([tagId, value]) => {
      const tag = readings.tagsById.get(tagId);
      return { label: tag?.name ?? `Tag ${tagId}`, tag, value, reason: null };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Contacts ─────────────────────────────────────────────────────────────────

const FRAME: Record<FlagTone, string> = {
  neutral: "border-line",
  bad: "border-bad/60 bg-bad/5",
  warn: "border-warn/60 bg-warn/5",
};

const PILL: Record<FlagTone, string> = {
  neutral: "border-line-strong bg-surface-sunken text-ink",
  bad: "border-bad/40 bg-bad/10 text-bad",
  warn: "border-warn/40 bg-warn/10 text-warn",
};

function alarmNote(alarm: Alarm, timezone: string | undefined): string {
  return (
    `Open Alarm: ${alarm.message} — ${alarm.severity}, since ${formatDateTime(alarm.opened_at, timezone)}` +
    (alarm.state === "acknowledged" ? ", acknowledged." : ".")
  );
}

export function FlagTile({
  filled,
  state,
  timezone,
}: {
  filled: Filled;
  state: FlagState;
  timezone: string | undefined;
}): JSX.Element {
  const missing = filled.value === null;
  const title = [
    filled.tag ? `${filled.tag.name} · ${filled.tag.code}` : null,
    missing ? filled.reason : null,
    state.alarm ? alarmNote(state.alarm, timezone) : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={`surface-tile flex min-w-0 items-center justify-between gap-3 rounded-card border px-3.5 py-2.5 ${FRAME[state.tone]}`}
      title={title || undefined}
    >
      <span className="min-w-0 truncate text-sm text-ink">{filled.label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {state.alarm ? <SeverityBadge severity={state.alarm.severity} /> : null}
        {missing && filled.reason ? <InfoHint text={filled.reason} /> : null}
        <span
          className={`figure min-w-[3.25rem] rounded border px-2 py-0.5 text-center text-xs font-semibold tracking-wide ${
            missing ? "border-line bg-surface-sunken text-ink-faint" : PILL[state.tone]
          }`}
        >
          {state.word}
        </span>
      </span>
    </div>
  );
}

const MARKING_RULE =
  "A contact is marked only while an open Alarm names it — the Alarm Rules decide which state is a fault.";

/** What the contacts panel says about its own colours — including when it cannot know. */
function flagsSubtitle(alarmsFailed: boolean): string {
  return alarmsFailed
    ? "Open Alarms could not be loaded, so no contact is marked — which here means unknown, not healthy."
    : `Each state as the equipment sends it. ${MARKING_RULE}`;
}

// ── One Device ───────────────────────────────────────────────────────────────

/**
 * A Device's figures and contacts. `headed` when several share the page: then
 * the Device's name, status and last contact sit on its own panel rather than
 * in the page header.
 */
function DeviceSection({
  spec,
  device,
  readings,
  timezone,
  headed,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  readings: DeviceReadings;
  timezone: string | undefined;
  headed: boolean;
}): JSX.Element {
  const canOpenAlarms = useDashboard("alarms");
  // Two small queries rather than the latest hundred of any state: a Device
  // that drops off the network collects resolved absence Alarms by the
  // hundred, and an acknowledged trip older than those must still show.
  const active = useAlarms({ deviceId: device.id, state: "active" });
  const acknowledged = useAlarms({ deviceId: device.id, state: "acknowledged" });
  const alarms = useMemo(
    () => openAlarmsByTag([...(active.data ?? []), ...(acknowledged.data ?? [])], device.id),
    [active.data, acknowledged.data, device.id],
  );
  const alarmsFailed = active.isError || acknowledged.isError;

  const figures = spec.figures
    .map((figure) => ({ figure, filled: readings.fill(figure) }))
    .filter(({ figure, filled }) => figureShown(figure, filled, readings.bound));
  const flags = spec.flags.map((position: Position) => {
    const filled = readings.fill(position);
    return { filled, state: flagState(filled.value, filled.tag?.code, alarms) };
  });
  const marked = flags.filter(({ state }) => state.alarm !== null).length;
  const others = otherSignals(readings, [...figures.map(({ filled }) => filled), ...flags.map(({ filled }) => filled)]);

  const name = deviceName(device);
  const openAlarms =
    marked > 0 ? (
      canOpenAlarms ? (
        <Link to="/d/alarms" className="text-xs font-medium text-bad hover:underline">
          {marked} {marked === 1 ? "contact" : "contacts"} with an open Alarm
        </Link>
      ) : (
        <span className="text-xs font-medium text-bad">
          {marked} {marked === 1 ? "contact" : "contacts"} with an open Alarm
        </span>
      )
    ) : null;

  const tiles = (
    <div className={spec.flagGrid}>
      {flags.map(({ filled, state }) => (
        <FlagTile key={filled.label} filled={filled} state={state} timezone={timezone} />
      ))}
    </div>
  );
  const figureRow =
    figures.length > 0 ? (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
        {figures.map(({ figure, filled }) => (
          <ReadingTile key={figure.label} icon={figure.icon} label={figure.label} filled={filled} />
        ))}
      </div>
    ) : null;
  // Rendered only when there are any: a section that says "nothing else" on
  // every Device is one people stop reading.
  const otherDetails =
    others.length > 0 ? (
      <details className="group rounded-card border border-line bg-surface-raised">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-ink">
          Other signals {spec.subject} reported
          <span className="ml-2 font-normal text-ink-muted">{others.length}</span>
        </summary>
        <div className="grid grid-cols-2 gap-3 border-t border-line p-4 sm:grid-cols-3 lg:grid-cols-5">
          {others.map((filled) => (
            <FigureTile key={filled.label} filled={filled} />
          ))}
        </div>
      </details>
    ) : null;

  if (headed) {
    return (
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2 text-base">
            {name ?? <span className="font-mono">{device.code}</span>}
            {name ? <span className="font-mono text-sm font-medium text-ink-muted">{device.code}</span> : null}
          </span>
        }
        // The rule is stated once in the page header; a panel speaks only when
        // its own Alarms could not be loaded.
        subtitle={alarmsFailed ? flagsSubtitle(true) : undefined}
        actions={
          <>
            {openAlarms}
            <CommStatusPill status={device.comm_status} />
          </>
        }
        padding="p-4"
      >
        <div className="flex flex-col gap-4">
          {figureRow}
          {tiles}
          {otherDetails}
          <p className="text-xs text-ink-faint">
            Last updated{" "}
            <span className="figure text-ink-muted">
              {readings.heard ? formatDateTime(readings.heard, timezone) : "never"}
            </span>
          </p>
          {spec.flagTrends ? (
            <FlagTrends spec={spec} device={device} readings={readings} timezone={timezone} embedded />
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <>
      {figureRow}
      <Panel
        title={<span className="text-base">Status flags</span>}
        subtitle={flagsSubtitle(alarmsFailed)}
        actions={openAlarms}
        padding="p-4"
      >
        {tiles}
      </Panel>
      {otherDetails}
    </>
  );
}

// ── Trends ───────────────────────────────────────────────────────────────────

function Trends({
  spec,
  device,
  readings,
  timezone,
  plantId,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  readings: DeviceReadings;
  timezone: string | undefined;
  plantId: number;
}): JSX.Element {
  const { period } = useHistoryPeriod();
  const panels = spec.trends.map((trend: TrendSpec) => ({
    trend,
    lines: trend.lines
      .map((figure) => ({ figure, filled: readings.fill(figure) }))
      .filter(({ figure, filled }) => figureShown(figure, filled, readings.bound)),
  }));
  const trends = useDeviceTrends(
    device,
    panels.flatMap(({ lines }) => lines.map(({ filled }) => filled.tag)),
    period,
    timezone,
    readings.tagsById,
  );
  const chartHeight = 240;
  const day = trends.range?.day ?? null;
  const canExport = usePermission("data.export");
  const canReadMaintenance = usePermission("plant.manage");
  // This Device's own Alarms, and planned work on it or the whole Plant.
  const { events } = useTimelineEvents(plantId, trends.range, {
    deviceId: device.id,
    canReadMaintenance,
    live: trends.live,
  });
  const dates = timezone ? periodDates(period, Date.now(), timezone) : null;
  // Every chart here spans the whole period, as the contact trends below do.
  const frame = trends.range
    ? { from: Date.parse(trends.range.from), to: Date.parse(trends.range.to) }
    : null;

  return (
    <Panel
      title={<span className="text-base">Trends</span>}
      subtitle={
        <span className="text-sm">
          A break in a line is a stretch in which nothing was received from {spec.subject} — not a
          reading of zero, and never drawn as one.
        </span>
      }
      padding="p-4"
    >
      {trends.isError ? (
        <ErrorState error={trends.error} retry={trends.refetch} />
      ) : (
        <div className="grid gap-x-6 gap-y-6 lg:grid-cols-2">
          {panels.map(({ trend, lines }) => {
            const withTag = lines.filter(({ filled }) => filled.tag);
            const units = new Set(withTag.map(({ filled }) => filled.tag?.unit));
            const unit = unitOf(withTag[0]?.filled.tag);
            return (
              <section key={trend.key} className="min-w-0">
                <h3 className="field-label mb-1">
                  {trend.title}
                  {unit ? ` (${unit})` : ""}
                </h3>
                {withTag.length === 0 ? (
                  // Guardrail 26: the reason, never an empty frame.
                  <p className="py-8 text-center text-xs text-ink-faint">{lines[0]?.filled.reason}</p>
                ) : units.size > 1 ? (
                  // One axis only for one unit (Guardrail 22).
                  <p className="py-8 text-center text-xs text-ink-faint">
                    These readings are recorded in different units, so they are not drawn on one axis.
                  </p>
                ) : withTag.length === 1 && withTag[0] ? (
                  <TrendChart
                    points={trends.seriesOf(withTag[0].filled.tag).points}
                    unit={unit}
                    label={withTag[0].filled.label}
                    tier={trends.tier}
                    provenance={device.code}
                    flaggedCount={trends.seriesOf(withTag[0].filled.tag).flaggedCount}
                    isLoading={trends.isLoading}
                    timezone={timezone}
                    height={chartHeight}
                    day={day}
                    markPeak={trend.markPeak}
                    band
                    events={events}
                    frame={frame}
                    exportName={
                      canExport ? exportStem(device.code, trend.key, dates?.first, dates?.last) : null
                    }
                  />
                ) : (
                  <OverlayTrendChart
                    series={withTag.map(({ figure, filled }) => ({
                      key: figure.codes[0] ?? figure.label,
                      label: filled.label,
                      ...trends.seriesOf(filled.tag),
                    }))}
                    unit={unit}
                    tier={trends.tier}
                    isLoading={trends.isLoading}
                    timezone={timezone}
                    height={chartHeight}
                    day={day}
                    frame={frame}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Setpoint against actual ──────────────────────────────────────────────────

/** The coarser of two tiers — the resolution both lines on one chart share. */
function coarser(a: Tier | null, b: Tier | null): Tier | null {
  if (a === null) return b;
  if (b === null) return a;
  return TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b;
}

/**
 * One setpoint and what the Plant did, on one axis in one unit (Guardrail 22:
 * a single scale, so the gap between the lines is a real difference). "Actual"
 * is the slot's own resolution — the same meter the Plant's screens read — and
 * where it answers in another unit than the setpoint (an LT meter's V against a
 * kV setpoint) it is not drawn, and the legend says why.
 */
function VersusChart({
  pair,
  setpoint,
  setpointTag,
  setpointTier,
  control,
  plantId,
  range,
  live,
  timezone,
}: {
  pair: VersusSpec;
  setpoint: TrendSeries;
  setpointTag: Tag | undefined;
  setpointTier: Tier | null;
  control: Filled;
  plantId: number;
  range: WindowRange | null;
  live: boolean;
  timezone: string | undefined;
}): JSX.Element {
  const actual = useSlotSeries(plantId, pair.actualSlot, range, { live });
  const unit = unitOf(setpointTag);
  const actualUnit = actual.unit && !NOT_A_UNIT.has(actual.unit) ? actual.unit : null;
  const mismatch = actual.unavailableReason === null && actualUnit !== unit && !actual.isLoading;
  const actualReason =
    actual.unavailableReason ??
    (mismatch ? `measured in ${actualUnit ?? "no unit"}, the setpoint in ${unit ?? "no unit"} — not drawn on one axis` : null);
  const controlWord = control.value === null ? null : control.value >= 0.5 ? "TRUE" : "FALSE";

  return (
    <section className="min-w-0">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="field-label">
          {pair.title}: setpoint vs actual{unit ? ` (${unit})` : ""}
        </h3>
        <span className="text-[11px] text-ink-faint" title={control.tag ? `${control.tag.name} · ${control.tag.code}` : undefined}>
          {pair.control.label} now{" "}
          <span className="figure font-semibold text-ink-muted">{controlWord ?? "—"}</span>
        </span>
      </div>
      {!setpointTag ? (
        <p className="py-8 text-center text-xs text-ink-faint">{control.reason ?? "This setpoint is not in the catalogue."}</p>
      ) : (
        <OverlayTrendChart
          series={[
            {
              key: "setpoint",
              label: "Setpoint",
              points: setpoint.points,
              flaggedCount: setpoint.flaggedCount,
              commanded: true,
            },
            {
              key: "actual",
              label: actual.provenance ? `Actual · ${actual.provenance}` : "Actual",
              points: actualReason ? [] : actual.points,
              flaggedCount: actualReason ? 0 : actual.flaggedCount,
              unavailableReason: actualReason,
            },
          ]}
          unit={unit}
          tier={coarser(setpointTier, actualReason ? null : actual.tier)}
          isLoading={actual.isLoading}
          timezone={timezone}
          height={220}
          day={range?.day ?? null}
          frame={range ? { from: Date.parse(range.from), to: Date.parse(range.to) } : null}
        />
      )}
      {actualReason ? (
        <p className="mt-1 text-[11px] text-ink-faint">No actual line: {actualReason.replace(/[.\s]+$/, "")}.</p>
      ) : null}
    </section>
  );
}

/**
 * Every setpoint of the spec against what the Plant did, over one window. The
 * setpoints come in one request (`useDeviceTrends`); each "actual" through its
 * slot (`useSlotSeries`).
 */
function SetpointTrends({
  spec,
  device,
  readings,
  timezone,
  plantId,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  readings: DeviceReadings;
  timezone: string | undefined;
  plantId: number;
}): JSX.Element {
  const { period } = useHistoryPeriod();
  const pairs = (spec.versus ?? []).map((pair) => ({
    pair,
    filled: readings.fill(pair.setpoint),
    control: readings.fill(pair.control),
  }));
  const trends = useDeviceTrends(
    device,
    pairs.map(({ filled }) => filled.tag),
    period,
    timezone,
    readings.tagsById,
  );
  return (
    <Panel
      title={<span className="text-base">Setpoint vs actual</span>}
      subtitle={
        <span className="text-sm">
          Each setpoint {spec.subject} commanded (dashed) against what the meter at the point of connection
          measured. While a control is FALSE its setpoint is not in force, and 0 there means "not commanded".
        </span>
      }
      padding="p-4"
    >
      {trends.isError ? (
        <ErrorState error={trends.error} retry={trends.refetch} />
      ) : (
        <div className="grid gap-x-6 gap-y-6 lg:grid-cols-2">
          {pairs.map(({ pair, filled, control }) => (
            <VersusChart
              key={pair.key}
              pair={pair}
              setpoint={trends.seriesOf(filled.tag)}
              setpointTag={filled.tag}
              setpointTier={trends.tier}
              control={control}
              plantId={plantId}
              range={trends.range}
              live={trends.live}
              timezone={timezone}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Contacts over time ───────────────────────────────────────────────────────

/**
 * Every contact of the spec as a step trend, TRUE/FALSE over the window — the
 * client's reference (1 Nov 2026). One request for all of them
 * (`useDeviceTrends`), one window, and every chart on the same x-axis so a
 * trip on one lines up with a change on the next. `embedded` inside a
 * breaker's own panel, where several breakers share the page.
 */
function FlagTrends({
  spec,
  device,
  readings,
  timezone,
  embedded,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  readings: DeviceReadings;
  timezone: string | undefined;
  embedded: boolean;
}): JSX.Element {
  const { period } = useHistoryPeriod();
  const flags = spec.flags.map((position: Position) => readings.fill(position));
  const trends = useDeviceTrends(
    device,
    flags.map((filled) => filled.tag),
    period,
    timezone,
    readings.tagsById,
  );
  const range = trends.range;
  const from = range ? Date.parse(range.from) : 0;
  const to = range ? Date.parse(range.to) : 0;
  // A contact is never throttled, so it is due every Device cycle.
  const cycleMs = (device.expected_interval_s ?? 0) * 1000;

  const subtitle =
    "Each signal as the equipment sent it, held until it changed. A dot marks a change; a ring marks a " +
    "stretch that saw both states. A break is a stretch with nothing received — never drawn as FALSE.";

  const body = trends.isError ? (
    <ErrorState error={trends.error} retry={trends.refetch} />
  ) : (
    <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
      {flags.map((filled) => {
        const series = stateSeries(trends.itemsOf(filled.tag), trends.tier, cycleMs);
        const empty = series.points.every((point) => point.state === null);
        return (
          <section key={filled.label} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <h3
                className="field-label truncate"
                title={filled.tag ? `${filled.tag.name} · ${filled.tag.code}` : undefined}
              >
                {filled.label}
              </h3>
              {series.changes.length > 0 ? (
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {series.changes.length} change{series.changes.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {!filled.tag ? (
              // Guardrail 26: the reason, never an empty frame.
              <p className="py-6 text-center text-xs text-ink-faint">{filled.reason}</p>
            ) : trends.isLoading ? (
              <div className="h-[132px] animate-pulse rounded bg-surface-sunken" />
            ) : empty ? (
              <p className="flex h-[132px] items-center justify-center text-center text-xs text-ink-faint">
                {series.flaggedCount > 0
                  ? `${series.flaggedCount} reading(s) arrived but were flagged unreadable, so none is drawn.`
                  : `Nothing received from ${spec.subject} for this signal in this window.`}
              </p>
            ) : (
              <>
                <StateTrendChart
                  series={series}
                  label={filled.label}
                  tier={trends.tier}
                  from={from}
                  to={to}
                  day={range?.day ?? null}
                  timezone={timezone}
                />
                {series.flaggedCount > 0 ? (
                  <p className="text-[11px] text-ink-faint">
                    {series.flaggedCount} flagged reading(s) not drawn.
                  </p>
                ) : null}
              </>
            )}
          </section>
        );
      })}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">Signal trends</h3>
            <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
          </div>
        </div>
        {body}
      </div>
    );
  }
  return (
    <Panel
      title={<span className="text-base">Status flag trends</span>}
      subtitle={<span className="text-sm">{subtitle}</span>}
      padding="p-4"
    >
      {body}
    </Panel>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

/** One Device on screen: its section, its trends and the header share one set of readings. */
function OneDevice({
  spec,
  device,
  readings,
  timezone,
  plantId,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  readings: DeviceReadings;
  timezone: string | undefined;
  plantId: number;
}): JSX.Element {
  return (
    <>
      <DeviceSection spec={spec} device={device} readings={readings} timezone={timezone} headed={false} />
      {spec.trends.length > 0 ? (
        <Trends spec={spec} device={device} readings={readings} timezone={timezone} plantId={plantId} />
      ) : null}
      {spec.versus && spec.versus.length > 0 ? (
        <SetpointTrends spec={spec} device={device} readings={readings} timezone={timezone} plantId={plantId} />
      ) : null}
      {spec.flagTrends ? (
        <FlagTrends spec={spec} device={device} readings={readings} timezone={timezone} embedded={false} />
      ) : null}
    </>
  );
}

function HeadedDevice({
  spec,
  device,
  timezone,
}: {
  spec: EquipmentSpec;
  device: DeviceListItem;
  timezone: string | undefined;
}): JSX.Element {
  const readings = useDeviceReadings(device, spec.subject);
  return <DeviceSection spec={spec} device={device} readings={readings} timezone={timezone} headed />;
}

/** "Last updated" for the page header, from the Device the page is about. */
function HeardLine({
  device,
  heard,
  timezone,
}: {
  device: DeviceListItem;
  heard: string | null;
  timezone: string | undefined;
}): JSX.Element {
  const name = deviceName(device);
  return (
    <>
      <span className={`font-medium text-ink ${name ? "" : "font-mono"}`}>{name ?? device.code}</span>
      {name ? <span className="font-mono text-ink-faint"> {device.code}</span> : null}
      {" · "}Last updated{" "}
      <span className="figure text-ink">{heard ? formatDateTime(heard, timezone) : "never"}</span>
      {timezone ? <span className="text-ink-faint"> · {timezoneLabel(timezone)} time</span> : null}
    </>
  );
}

export function EquipmentDashboard({ spec }: { spec: EquipmentSpec }): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const timezone = plantQuery.data?.timezone;

  const devices = useMemo(
    () =>
      (devicesQuery.data ?? [])
        .filter((device) => spec.typeCodes.includes(device.type_code))
        .sort(byTypeThenCode(spec.typeCodes)),
    [devicesQuery.data, spec.typeCodes],
  );
  /** `null` means "the first", so a Plant switch never strands a stale id. */
  const [chosenId, setChosenId] = useState<number | null>(null);
  const chosen = devices.find((device) => device.id === chosenId) ?? devices[0] ?? null;
  // Several at once only where the spec asks for it; one of them is just one.
  const every = spec.showEvery && devices.length > 1;
  const readings = useDeviceReadings(every ? null : chosen, spec.subject);
  const { period, setPeriod } = useHistoryPeriod();

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const hasTrends = spec.trends.length > 0 || (spec.versus?.length ?? 0) > 0 || spec.flagTrends;
  // One period for every trend on the screen, and the same one the other
  // history screens show (`useHistoryPeriod`) — it used to be a control on
  // each panel, so two panels could sit on different spans looking aligned.
  const periodBar = hasTrends ? (
    <HistoryPeriodBar
      period={period}
      onChange={setPeriod}
      timezone={timezone}
      nowMs={Math.floor(Date.now() / 60_000) * 60_000}
      note="The figures and contacts above the trends are always the latest; the period sets the trends."
    />
  ) : null;

  const header = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="page-title">{spec.title}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {chosen && !every ? (
            <HeardLine device={chosen} heard={readings.heard} timezone={timezone} />
          ) : every ? (
            <>
              {spec.intro} <span className="figure text-ink">{devices.length}</span> at this Plant.{" "}
              {MARKING_RULE}
            </>
          ) : (
            spec.intro
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
        {chosen && !every ? <CommStatusPill status={chosen.comm_status} /> : null}
        {devices.length > 1 && chosen && !every ? (
          <SelectBox
            label={spec.noun}
            value={String(chosen.id)}
            onChange={(next) => setChosenId(Number(next))}
            display={<span className="font-mono">{chosen.code}</span>}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.code}
                {deviceName(device) ? ` — ${deviceName(device)}` : ""}
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
        <SkeletonKpiRow tiles={spec.figures.length > 0 ? spec.figures.length : 4} />
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
  if (!chosen) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {/* Guardrail 26: say which of the two blanks this is. */}
        <EmptyState title={spec.empty.title} detail={`${spec.empty.detail} Register one through Plants & Devices.`} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {periodBar}
      {every ? (
        devices.map((device) => <HeadedDevice key={device.id} spec={spec} device={device} timezone={timezone} />)
      ) : (
        // Keyed on the Device, so a switch starts its panels afresh rather
        // than carrying one Device's state onto another. The period is the
        // screen's, and stays.
        <OneDevice
          key={chosen.id}
          spec={spec}
          device={chosen}
          readings={readings}
          timezone={timezone}
          plantId={plantId ?? 0}
        />
      )}
    </div>
  );
}

export const TransformerDashboard = () => <EquipmentDashboard spec={TRANSFORMER} />;
export const PpcDashboard = () => <EquipmentDashboard spec={PPC} />;
export const VcbDashboard = () => <EquipmentDashboard spec={VCB} />;
