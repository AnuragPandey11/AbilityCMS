/**
 * One Inverter in full — the client's reference screen, opened from Inverter
 * Monitoring.
 *
 * Top to bottom: the AC side (three line voltages, three phase currents, the
 * powers, PF and frequency), then DC parameters, energy and performance side
 * by side, then every PV string, then six trends over a chosen window.
 *
 * ── Where the figures come from ─────────────────────────────────────────────
 * - **Values** — the last good stored reading of every Tag this Inverter sent
 *   in the last thirty minutes, with the live frame over it. Fetched with no
 *   Tag filter, so the screen is built from what the Device *reported*, and a
 *   signal nothing here places is listed under "Other signals" rather than
 *   dropped (§0.3: what a Device shows is its own data, never a list per Type).
 * - **Positions** — each names catalogue Tag codes in order of preference
 *   (`AC_VOLTAGE_RY` before `HV_VOLTAGE_RY`), and the first this Inverter
 *   reports wins. They name Tags, never a Client, Plant or Device (Guardrail
 *   2), and the unit is always the Tag's own — a line voltage in kV on one
 *   Model and V on another is labelled as each.
 * - **Operating status** — `GET /devices/{id}/operating-status`: the Plant's
 *   start/stop rule on this machine's own output. The Inverter's own status
 *   code is shown beside it *as sent*: nobody has supplied what its values
 *   mean, and "512 → Running" would be a translation this screen invented.
 * - **Strings** — PV1 to PV*n*, where *n* is the unit's recorded string count.
 *   With none recorded, none of the group is bound, and the section says so.
 *
 * ── Rules it keeps ──────────────────────────────────────────────────────────
 * - A missing value is "—" with its reason, never 0 — and the reason is as
 *   specific as this session can know: "not bound" where bindings are
 *   readable, "nothing received" where they are not (Guardrail 26).
 * - "No current" on a string is only said while the Inverter is generating. At
 *   night every string carries nothing, and eight red badges would say eight
 *   faults (Guardrail 16's cousin: absence alone proves nothing).
 * - Each trend is one measure on its own axis (Guardrail 22), gaps stay gaps
 *   (Guardrail 23), and flagged readings are counted, not drawn.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CommStatus,
  DeviceDetail,
  DeviceListItem,
  DeviceOperatingStatus,
  ReadingPoint,
  Tag,
  Tier,
} from "@/api/schemas";
import { useBindings, useDevice, useDeviceOperatingStatus, useTags } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as readingsApi from "@/api/endpoints/readings";
import { withGaps, type TrendPoint } from "@/api/useSlotTrend";
import { Panel, SegmentedControl } from "@/components/ui";
import { TrendChart } from "@/components/charts/TrendChart";
import { Skeleton } from "@/components/state";
import { usePermission } from "@/auth/usePermission";
import { UNDEFINED_DISPLAY, digitsForUnit, formatHeadline } from "@/format/value";
import { dayInZone, formatDateTime, formatTime } from "@/format/datetime";

// ── The layout ───────────────────────────────────────────────────────────────

/** A position on the screen and the Tags that can fill it, preferred first. */
interface Position {
  label: string;
  codes: string[];
}

const AC_SIDE: Position[] = [
  { label: "Voltage R-Y", codes: ["AC_VOLTAGE_RY", "HV_VOLTAGE_RY"] },
  { label: "Voltage Y-B", codes: ["AC_VOLTAGE_YB", "HV_VOLTAGE_YB"] },
  { label: "Voltage B-R", codes: ["AC_VOLTAGE_BR", "HV_VOLTAGE_BR"] },
  { label: "Current R", codes: ["AC_CURRENT_R"] },
  { label: "Current Y", codes: ["AC_CURRENT_Y"] },
  { label: "Current B", codes: ["AC_CURRENT_B"] },
  { label: "Active Power", codes: ["AC_ACTIVE_POWER"] },
  { label: "Reactive Power", codes: ["AC_REACTIVE_POWER"] },
  { label: "Power Factor", codes: ["POWER_FACTOR"] },
  { label: "Frequency", codes: ["FREQUENCY"] },
];

const DC_SIDE: Position[] = [
  { label: "DC Voltage", codes: ["DC_VOLTAGE", "PV_VOLTAGE"] },
  { label: "DC Current", codes: ["DC_CURRENT", "PV_CURRENT"] },
];

/** Calculated from AC output over efficiency (`tags.formula`), so undefined at night. */
const DC_POWER: Position = { label: "DC Power", codes: ["DC_POWER"] };

const ENERGY: Position[] = [
  { label: "Daily Energy", codes: ["ENERGY_TODAY"] },
  { label: "Monthly Energy", codes: ["ENERGY_MONTHLY"] },
  { label: "Cumulative Energy", codes: ["ENERGY_TOTAL", "ENERGY_CUMULATIVE_MWH"] },
];

const EFFICIENCY: Position = { label: "Efficiency", codes: ["INVERTER_EFFICIENCY"] };
const TEMPERATURE: Position = { label: "Temperature", codes: ["DEVICE_TEMPERATURE"] };
const STATUS_CODE: Position = { label: "Status code", codes: ["DEVICE_STATUS"] };

/**
 * The six trends, each in its own colour as the client's reference draws
 * them, so six panels of one shape are told apart at a glance.
 *
 * Chosen clear of the hues status owns — no green, amber or red line, because
 * a temperature drawn in red reads as a verdict on it (Guardrail 34's
 * reasoning). That rules out the palette's aqua (a few degrees from "healthy")
 * and yellow (beside "warning") as well as its green and red, which leaves four
 * slots, the accent and the neutral ink: exactly six.
 */
const TRENDS: (Position & { slot?: number; tone?: "accent" | "neutral" })[] = [
  { label: "Active Power", codes: ["AC_ACTIVE_POWER"], slot: 0 }, // blue, as power is everywhere
  { ...DC_SIDE[0]!, slot: 6 }, // violet
  { ...DC_SIDE[1]!, slot: 4 }, // magenta
  { ...EFFICIENCY, tone: "accent" },
  { ...TEMPERATURE, slot: 1 }, // orange
  { label: "Power Factor", codes: ["POWER_FACTOR"], tone: "neutral" }, // slate
];

const stringCodes = (n: number) => ({
  current: `PV${n}_CURRENT`,
  power: `PV${n}_ACTIVE_POWER`,
  voltage: `PV${n}_VOLTAGE`,
});

/** Units that are type names rather than units, and are not printed as one. */
const NOT_A_UNIT = new Set(["ratio", "code", "bool"]);

// ── Values ───────────────────────────────────────────────────────────────────

/** How far back a "current" value may come from, as `useLatestValues` uses. */
const LOOKBACK_MINUTES = 30;

/**
 * The last good value of every Tag this Device sent recently, keyed by Tag id.
 *
 * No Tag filter: the screen must be able to list what it did not expect, and a
 * filter built from the layout would make anything outside it invisible.
 */
function useDeviceLatest(deviceId: number): { values: Map<number, number>; isLoading: boolean } {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const query: readingsApi.ReadingsQuery = {
    deviceIds: [deviceId],
    from: new Date(now - LOOKBACK_MINUTES * 60_000).toISOString(),
    to: new Date(now).toISOString(),
    resolution: "agg_1m",
  };
  const readings = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const values = useMemo(() => {
    const out = new Map<number, number>();
    for (const point of (readings.data?.items ?? []) as ReadingPoint[]) {
      // A flagged value is not presented as a reading (Guardrail 4). Buckets
      // arrive ascending, so the last write per Tag is the latest good value.
      if (point.quality !== null && point.quality !== 0) continue;
      if (point.value === null) continue;
      out.set(point.tag_id, point.value);
    }
    return out;
  }, [readings.data]);
  return { values, isLoading: readings.isLoading };
}

/** A position filled — or not, and why. */
export interface Filled {
  label: string;
  tag: Tag | undefined;
  value: number | null;
  reason: string | null;
}

// ── Presentation ─────────────────────────────────────────────────────────────

type Tone = "ink" | "ok" | "warn" | "bad" | "muted" | "faint";

const TONE: Record<Tone, string> = {
  ink: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-ink-muted",
  faint: "text-ink-faint",
};

function valueText(filled: Filled): { text: string; unit: string | null; title: string | undefined } {
  const { tag, value } = filled;
  if (value === null || !tag) return { text: UNDEFINED_DISPLAY, unit: null, title: undefined };
  // A status code is an identifier the Device sent, not a quantity: printed
  // whole, never as ON/OFF, which is what a contact would be.
  if (tag.unit === "code") return { text: String(value), unit: null, title: undefined };
  if (tag.category === "status") return { text: value === 0 ? "OFF" : "ON", unit: null, title: undefined };
  const headline = formatHeadline(value, { digits: digitsForUnit(tag.unit) });
  const unit = tag.unit && !NOT_A_UNIT.has(tag.unit) ? tag.unit : null;
  return {
    text: headline.text,
    unit,
    title: headline.compacted ? `${headline.exact}${unit ? ` ${unit}` : ""}` : undefined,
  };
}

function FigureTile({ filled, emphasis = false }: { filled: Filled; emphasis?: boolean }): JSX.Element {
  const { text, unit, title } = valueText(filled);
  const missing = filled.value === null;
  return (
    <div
      className="surface-tile min-w-0 rounded-card border border-line px-4 py-3"
      title={
        missing
          ? (filled.reason ?? undefined)
          : [filled.tag ? `${filled.tag.name} · ${filled.tag.code}` : null, title].filter(Boolean).join(" — ")
      }
    >
      <div className="truncate text-xs font-medium text-ink-muted">{filled.label}</div>
      <div
        className={`figure mt-1 truncate font-semibold leading-tight ${
          emphasis ? "text-[1.6rem]" : "text-xl"
        } ${missing ? "text-ink-faint" : "text-ink"}`}
      >
        {text}
        {unit ? <span className="ml-1 text-xs font-medium text-ink-muted">{unit}</span> : null}
      </div>
    </div>
  );
}

/** A tile whose figure is a word — a state rather than a reading. */
function StateTile({
  label,
  word,
  tone,
  detail,
  title,
}: {
  label: string;
  word: string;
  tone: Tone;
  detail?: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <div className="surface-tile min-w-0 rounded-card border border-line px-4 py-3" title={title}>
      <div className="truncate text-xs font-medium text-ink-muted">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold leading-tight ${TONE[tone]}`}>{word}</div>
      {detail ? <div className="mt-1 truncate text-[11px] text-ink-faint">{detail}</div> : null}
    </div>
  );
}

const heading = (text: string) => <span className="text-base">{text}</span>;

// ── Operating and comms ──────────────────────────────────────────────────────

function clock(at: string | null, timeZone: string): string {
  return at ? formatTime(at, timeZone).slice(0, 5) : UNDEFINED_DISPLAY;
}

function operatingTile(
  status: DeviceOperatingStatus | undefined,
  isLoading: boolean,
  code: Filled,
  timeZone: string,
): JSX.Element {
  const codeNote =
    code.value !== null
      ? `Status code ${code.value}`
      : undefined;
  const codeTitle =
    " The Inverter's own status code is shown as sent: what each value means has not been " +
    "supplied (TAG_CATALOGUE §2.4 leaves it blank), so it is not translated into a word.";
  if (!status) {
    return (
      <StateTile
        label="Operating Status"
        word={isLoading ? "…" : UNDEFINED_DISPLAY}
        tone="faint"
        detail={codeNote}
        title={isLoading ? undefined : `The operating status could not be loaded.${codeTitle}`}
      />
    );
  }
  const { operating, today } = status;
  const rule =
    `Running once this Inverter's AC output rises above ${operating.start_above} ${operating.unit}, ` +
    `until it falls back to ${operating.stop_at_or_below} ${operating.unit} — the Plant's own rule.`;
  const since = today.start_at
    ? `${today.start_observed ? "since" : "by"} ${clock(today.start_at, timeZone)}`
    : null;
  switch (operating.state) {
    case "running":
      return (
        <StateTile
          label="Operating Status"
          word="Running"
          tone="ok"
          detail={[since, codeNote].filter(Boolean).join(" · ")}
          title={`${rule}${codeTitle}`}
        />
      );
    case "stopped":
      return (
        <StateTile
          label="Operating Status"
          word="Stopped"
          tone="muted"
          detail={[today.stop_at ? `at ${clock(today.stop_at, timeZone)}` : null, codeNote]
            .filter(Boolean)
            .join(" · ")}
          title={`${rule}${codeTitle}`}
        />
      );
    case "not_started":
      return (
        <StateTile
          label="Operating Status"
          word="Not started"
          tone="muted"
          detail={codeNote}
          title={`${rule}${codeTitle}`}
        />
      );
    case "unknown":
      return (
        <StateTile
          label="Operating Status"
          word="Unknown"
          tone="warn"
          detail={codeNote}
          title={`${operating.undefined_reason ?? "Not heard from"}. ${rule}${codeTitle}`}
        />
      );
    default:
      return (
        <StateTile
          label="Operating Status"
          word={UNDEFINED_DISPLAY}
          tone="faint"
          detail={codeNote}
          title={`${operating.undefined_reason ?? "This Inverter reports no AC output"}.${codeTitle}`}
        />
      );
  }
}

const COMM: Record<CommStatus, { word: string; tone: Tone; note: string }> = {
  online: { word: "Online", tone: "ok", note: "Reporting within its expected interval." },
  degraded: { word: "Degraded", tone: "warn", note: "Late: past its expected interval, not yet silent." },
  offline: {
    word: "Offline",
    tone: "bad",
    note: "Not reporting. Communication loss — absence alone never proves the equipment is down.",
  },
  unknown: { word: "Unknown", tone: "muted", note: "Never heard from." },
};

// ── Strings ──────────────────────────────────────────────────────────────────

export interface StringState {
  text: string;
  tone: Tone;
  title: string;
}

export function stringState(current: number | null, generating: boolean): StringState {
  if (current === null) {
    return { text: "No reading", tone: "faint", title: "Nothing received for this string in the last 30 minutes." };
  }
  if (current > 0) return { text: "Producing", tone: "muted", title: "Carrying current." };
  if (generating) {
    return {
      text: "No current",
      tone: "bad",
      title: "No current on this string while the Inverter is generating — worth a look: shading, a blown fuse or an open connector.",
    };
  }
  return {
    text: "Idle",
    tone: "muted",
    title: "No current, and none expected: the Inverter is not generating.",
  };
}

const CHIP: Record<Tone, string> = {
  bad: "border-bad/40 bg-bad/10 text-bad",
  warn: "border-warn/40 bg-warn/10 text-warn",
  ok: "border-ok/40 bg-ok/10 text-ok",
  muted: "border-line bg-surface-sunken text-ink-muted",
  faint: "border-line bg-surface-sunken text-ink-faint",
  ink: "border-line bg-surface-sunken text-ink",
};

/** One PV string as the grid draws it. */
export interface StringReading {
  n: number;
  current: Filled;
  power: Filled;
  voltage: Filled;
  state: StringState;
}

/** The strings, four across: current, power, and what that means right now. */
export function StringGrid({ strings }: { strings: StringReading[] }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {strings.map(({ n, current, power, voltage, state }) => {
        const currentText = valueText(current);
        const powerText = valueText(power);
        const voltageText = valueText(voltage);
        return (
          <div
            key={n}
            data-testid={`string-${n}`}
            className={`surface-tile rounded-card border px-3 py-2.5 ${
              state.tone === "bad" ? "border-bad/45" : "border-line"
            }`}
            title={voltage.value !== null ? `Voltage ${voltageText.text} ${voltageText.unit ?? ""}` : undefined}
          >
            <div className="text-sm font-semibold text-accent">String {String(n).padStart(2, "0")}</div>
            <dl className="mt-1.5 space-y-0.5 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-muted">Current</dt>
                <dd
                  className={`figure font-semibold ${current.value === null ? "text-ink-faint" : "text-ink"}`}
                  title={current.reason ?? undefined}
                >
                  {currentText.text}
                  {currentText.unit ? <span className="ml-0.5 text-ink-muted">{currentText.unit}</span> : null}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-muted">Power</dt>
                <dd
                  className={`figure font-semibold ${power.value === null ? "text-ink-faint" : "text-ink"}`}
                  title={power.reason ?? undefined}
                >
                  {powerText.text}
                  {powerText.unit ? <span className="ml-0.5 text-ink-muted">{powerText.unit}</span> : null}
                </dd>
              </div>
            </dl>
            <div
              className={`mt-2 rounded border px-2 py-0.5 text-center text-[11px] font-semibold ${CHIP[state.tone]}`}
              title={state.title}
            >
              {state.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Trends ───────────────────────────────────────────────────────────────────

type TrendWindow = "today" | "yesterday" | "7d" | "30d";

const WINDOWS: { value: TrendWindow; label: string; hint: string }[] = [
  { value: "today", label: "Today", hint: "The Plant's day so far, per minute." },
  { value: "yesterday", label: "Yesterday", hint: "The Plant's previous day, per minute." },
  { value: "7d", label: "Last 7 days", hint: "In 15-minute buckets." },
  { value: "30d", label: "Last 30 days", hint: "Hourly." },
];

/** Six Tags on one Device: a day per minute is ~8,600 points, inside the 20,000 cap. */
const WINDOW_TIER: Record<TrendWindow, Tier> = {
  today: "agg_1m",
  yesterday: "agg_1m",
  "7d": "agg_15m",
  "30d": "agg_1h",
};

function trendRange(
  span: TrendWindow,
  now: number,
  timeZone: string,
): { from: string; to: string; day: { start: number; end: number } | null } {
  const today = dayInZone(now, timeZone);
  switch (span) {
    case "today":
      return { from: new Date(today.start).toISOString(), to: new Date(now).toISOString(), day: today };
    case "yesterday": {
      const yesterday = dayInZone(today.start - 1, timeZone);
      return {
        from: new Date(yesterday.start).toISOString(),
        to: new Date(yesterday.end).toISOString(),
        day: yesterday,
      };
    }
    default: {
      const days = span === "7d" ? 7 : 30;
      return {
        from: new Date(now - days * 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
        day: null,
      };
    }
  }
}

// ── The view ─────────────────────────────────────────────────────────────────

export function InverterView({
  device,
  live,
  timeZone,
}: {
  device: DeviceListItem;
  /** The live frame for this Device, keyed by Tag id — fresher than anything stored. */
  live: Record<string, number> | undefined;
  timeZone: string;
}): JSX.Element {
  const tagsQuery = useTags();
  const detailQuery = useDevice(device.id);
  const detail = detailQuery.data as DeviceDetail | undefined;
  const operatingQuery = useDeviceOperatingStatus(device.id);
  const latest = useDeviceLatest(device.id);
  // Bindings say "not bound" where this session may read them. For everybody
  // else the honest reason is the weaker "nothing received".
  const canReadBindings = usePermission("config.modify");
  const bindingsQuery = useBindings(device.id, canReadBindings);
  const bound = useMemo(
    () =>
      bindingsQuery.data
        ? new Set(bindingsQuery.data.filter((b) => b.enabled).map((b) => b.tag_code))
        : null,
    [bindingsQuery.data],
  );

  const tagsByCode = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.code, tag])),
    [tagsQuery.data],
  );
  const tagsById = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.id, tag])),
    [tagsQuery.data],
  );

  /** Stored latest, then the live frame over it, per Tag. */
  const values = useMemo(() => {
    const out = new Map(latest.values);
    for (const [key, value] of Object.entries(live ?? {})) out.set(Number(key), value);
    return out;
  }, [latest.values, live]);

  /** Fill a position: the first Tag this Inverter reports, else say why not. */
  const fill = (position: Position): Filled => {
    for (const code of position.codes) {
      const tag = tagsByCode.get(code);
      if (tag && values.has(tag.id)) return { label: position.label, tag, value: values.get(tag.id) ?? null, reason: null };
    }
    const boundCode = bound ? position.codes.find((code) => bound.has(code)) : undefined;
    const tag = tagsByCode.get(boundCode ?? position.codes[0]);
    let reason: string;
    if (latest.isLoading) reason = "Loading…";
    else if (bound && boundCode) reason = `Bound to ${boundCode}, but nothing received in the last ${LOOKBACK_MINUTES} minutes.`;
    else if (bound) reason = `This Inverter is not bound to ${position.codes.join(" or ")}, so it does not report this.`;
    else
      reason =
        `Nothing received in the last ${LOOKBACK_MINUTES} minutes — this Inverter may not report ` +
        `${position.codes.join(" or ")}, or it has gone quiet.`;
    return { label: position.label, tag, value: null, reason };
  };

  const ac = AC_SIDE.map(fill);
  const dc = DC_SIDE.map(fill);
  const dcPower = fill(DC_POWER);
  const energy = ENERGY.map(fill);
  const efficiency = fill(EFFICIENCY);
  const temperature = fill(TEMPERATURE);
  const statusCode = fill(STATUS_CODE);
  const comm = COMM[device.comm_status ?? "unknown"];

  const generating = operatingQuery.data?.operating.state === "running";
  const stringCount = detail?.string_count ?? null;
  const strings = Array.from({ length: stringCount ?? 0 }, (_, index) => {
    const n = index + 1;
    const codes = stringCodes(n);
    const current = fill({ label: "Current", codes: [codes.current] });
    const power = fill({ label: "Power", codes: [codes.power] });
    const voltage = fill({ label: "Voltage", codes: [codes.voltage] });
    return { n, current, power, voltage, state: stringState(current.value, generating) };
  });
  const withoutCurrent = strings.filter((s) => s.state.text === "No current").length;

  /** Every Tag id some position on the screen shows, for "Other signals". */
  const placed = new Set(
    [
      ...ac,
      ...dc,
      dcPower,
      ...energy,
      efficiency,
      temperature,
      statusCode,
      ...strings.flatMap((s) => [s.current, s.power, s.voltage]),
    ]
      .map((filled) => filled.tag?.id)
      .filter((id): id is number => id !== undefined),
  );
  const others = [...values.entries()]
    .filter(([tagId]) => !placed.has(tagId))
    .map(([tagId, value]) => {
      const tag = tagsById.get(tagId);
      return { label: tag?.name ?? `Tag ${tagId}`, tag, value, reason: null } satisfies Filled;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // ── Trends
  const [trendWindow, setTrendWindow] = useState<TrendWindow>("today");
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const range = trendRange(trendWindow, now, timeZone);
  const trendFills = TRENDS.map(fill);
  const trendTagIds = trendFills
    .map((filled) => filled.tag?.id)
    .filter((id): id is number => id !== undefined);
  const trendQueryArgs: readingsApi.ReadingsQuery = {
    deviceIds: [device.id],
    tagIds: [...new Set(trendTagIds)].sort((a, b) => a - b),
    from: range.from,
    to: range.to,
    resolution: WINDOW_TIER[trendWindow],
  };
  const trendQuery = useQuery({
    queryKey: qk.readings(trendQueryArgs),
    queryFn: () => readingsApi.getReadings(trendQueryArgs),
    enabled: trendTagIds.length > 0,
    retry: false,
    staleTime: 60_000,
    refetchInterval: trendWindow === "today" ? 60_000 : false,
    placeholderData: (previous) => previous,
  });
  const series = useMemo(() => {
    const byTag = new Map<number, { points: TrendPoint[]; flagged: number }>();
    for (const point of (trendQuery.data?.items ?? []) as ReadingPoint[]) {
      const entry = byTag.get(point.tag_id) ?? { points: [], flagged: 0 };
      byTag.set(point.tag_id, entry);
      if (point.quality !== null && point.quality !== 0) {
        entry.flagged += 1;
        continue;
      }
      if (point.value === null) continue;
      entry.points.push({ at: point.bucket, value: point.value, contributors: 1 });
    }
    const tier = trendQuery.data?.tier ?? null;
    for (const [tagId, entry] of byTag) {
      // How often this Tag on this Device is stored when all is well: its own
      // throttle or the Device's cycle, whichever is longer, plus one more
      // cycle — the health sweep's own tolerance before it calls a Device late.
      const throttle = tagsById.get(tagId)?.min_interval_s ?? 0;
      const cycle = device.expected_interval_s;
      entry.points = withGaps(entry.points, tier, (Math.max(throttle, cycle) + cycle) * 1000);
    }
    return byTag;
  }, [trendQuery.data, tagsById, device.expected_interval_s]);

  return (
    <div className="space-y-4">
      {/* The AC side: what crosses the Inverter's output terminals. */}
      <Panel title={heading("AC side")} padding="p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {ac.map((filled) => (
            <FigureTile key={filled.label} filled={filled} emphasis />
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={heading("DC Parameters")} padding="p-4">
          <div className="grid grid-cols-2 gap-3">
            {dc.map((filled) => (
              <FigureTile key={filled.label} filled={filled} />
            ))}
            <div className="col-span-2">
              <FigureTile filled={dcPower} />
            </div>
          </div>
        </Panel>
        <Panel title={heading("Energy")} padding="p-4">
          <div className="grid gap-3">
            {energy.map((filled) => (
              <FigureTile key={filled.label} filled={filled} />
            ))}
          </div>
        </Panel>
        <Panel title={heading("Performance")} padding="p-4">
          <div className="grid grid-cols-2 gap-3">
            <FigureTile filled={efficiency} />
            <FigureTile filled={temperature} />
            {operatingTile(operatingQuery.data, operatingQuery.isLoading, statusCode, timeZone)}
            <StateTile
              label="Comm Status"
              word={comm.word}
              tone={comm.tone}
              detail={
                device.last_seen_at ? `seen ${clock(device.last_seen_at, timeZone)}` : "never heard"
              }
              title={comm.note}
            />
          </div>
        </Panel>
      </div>

      <Panel
        title={heading("String Monitoring")}
        subtitle={
          stringCount ? (
            <span>
              {stringCount} string{stringCount === 1 ? "" : "s"} recorded on this unit
              {withoutCurrent > 0 ? (
                <span className="font-semibold text-bad"> · {withoutCurrent} without current</span>
              ) : null}
              {!generating && operatingQuery.data ? " · the Inverter is not generating" : ""}
            </span>
          ) : undefined
        }
        padding="p-4"
      >
        {detailQuery.isLoading ? (
          <Skeleton className="h-24 rounded-card" />
        ) : !stringCount ? (
          // Guardrail 26: a blank with a knowable reason says the reason.
          <p className="text-sm leading-snug text-ink-muted">
            No string count is recorded for this Inverter, so none of its PV inputs is bound and
            there are no strings to monitor. Record how many strings it has in Plants & Devices — a
            count is a fact about the unit, not the Model, because one datasheet covers a 12-string
            and a 24-string machine.
          </p>
        ) : (
          <StringGrid strings={strings} />
        )}
      </Panel>

      <Panel
        title={heading("Trends")}
        subtitle={
          <span className="text-sm">
            A break in a line is a stretch in which nothing was received from this Inverter — not a
            reading of zero, and never drawn as one.
          </span>
        }
        actions={
          <SegmentedControl
            label="Trend window"
            value={trendWindow}
            onChange={setTrendWindow}
            options={WINDOWS}
          />
        }
        padding="p-4"
      >
        <div className="grid gap-x-6 gap-y-5 lg:grid-cols-2">
          {trendFills.map((filled, index) => {
            const entry = filled.tag ? series.get(filled.tag.id) : undefined;
            return (
              <section key={filled.label} className="min-w-0">
                <h3 className="field-label mb-1">
                  {filled.label}
                  {filled.tag?.unit && !NOT_A_UNIT.has(filled.tag.unit) ? ` (${filled.tag.unit})` : ""}
                </h3>
                {!filled.tag ? (
                  <p className="py-8 text-center text-xs text-ink-faint">{filled.reason}</p>
                ) : (
                  <TrendChart
                    points={entry?.points ?? []}
                    unit={filled.tag.unit && !NOT_A_UNIT.has(filled.tag.unit) ? filled.tag.unit : null}
                    label={filled.label}
                    tier={trendQuery.data?.tier ?? null}
                    flaggedCount={entry?.flagged ?? 0}
                    isLoading={trendQuery.isLoading}
                    timezone={timeZone}
                    height={170}
                    day={range.day}
                    paletteSlot={TRENDS[index]?.slot}
                    colorToken={TRENDS[index]?.tone ?? "accent"}
                    // A peak means something for output; for a temperature or a
                    // power factor it is just the largest number.
                    markPeak={index === 0}
                  />
                )}
              </section>
            );
          })}
        </div>
      </Panel>

      {/* Rendered only when there are any: a section that says "nothing else"
          on every Inverter is one people stop reading. */}
      {others.length > 0 ? (
        <details className="group rounded-card border border-line bg-surface-raised">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-ink">
            Other signals this Inverter reported
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

/** The line under the drawer's title: who owns it, its size, when last heard. */
export function InverterHeadline({
  device,
  plantName,
  clientName,
  timeZone,
}: {
  device: DeviceListItem;
  plantName: string | null;
  clientName: string | null;
  timeZone: string;
}): JSX.Element {
  const detail = useDevice(device.id).data as DeviceDetail | undefined;
  const parts = [
    clientName,
    plantName,
    detail?.rated_capacity_kw !== null && detail?.rated_capacity_kw !== undefined
      ? `Rated ${formatHeadline(detail.rated_capacity_kw).text} kW`
      : null,
    device.variant ? `${device.variant} Inverter` : null,
    `Last updated ${device.last_seen_at ? formatDateTime(device.last_seen_at, timeZone) : "never"}`,
  ].filter(Boolean);
  const comm = COMM[device.comm_status ?? "unknown"];
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{parts.join(" · ")}</span>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${CHIP[comm.tone]}`}
        title={comm.note}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {comm.word}
      </span>
    </span>
  );
}
