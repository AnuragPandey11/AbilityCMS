/**
 * Plant Status — the Plant's state, its weather and its day, as one list.
 *
 * The client's reference card, row for row: whether it is generating, whether
 * it is on the grid, the five weather figures, when it started and stopped,
 * its peak, and whether anything is being heard from it at all.
 *
 * ── Where each row comes from ───────────────────────────────────────────────
 * - **State, start, stop, peak, grid** — `GET /plants/{id}/operating-status`.
 *   Every one is a *rule* (0.5 kW to start, 0 kW to stop, a breaker's ON
 *   FEEDBACK contact for the grid), and the rules live in the backend's
 *   `assumptions.py` — Guardrail 6 — so this file only renders what they
 *   decided, and says on the tooltip what they were.
 * - **Weather** — the `environment` slots, so each figure is the same claim,
 *   from the same Device, as everywhere else it appears.
 * - **Online, last updated** — Device health and last-seen times.
 *
 * ── Three things it will not do ─────────────────────────────────────────────
 * - **Say "running" on a Plant nobody can hear.** The backend returns
 *   `unknown` when the Inverters went quiet while generating; that renders as
 *   a warning, not as the last state they were in.
 * - **Print a start it did not see.** A Plant first heard at 13:55 already
 *   generating started somewhere before that, so the row reads "by 13:55" and
 *   the tooltip names the silence.
 * - **Call a Plant with no breaker "connected".** No VCB is no grid status,
 *   stated as such.
 */

import type { ReactNode } from "react";
import type {
  CommStatus,
  DeviceListItem,
  OperatingDay,
  OperatingStatus,
  ResolvedSlot,
} from "@/api/schemas";
import { undefinedExplanation, slotText, sourceLabel } from "@/components/dashboard/SlotValue";
import { Panel } from "@/components/ui";
import { Skeleton } from "@/components/state";
import { IconChevronRight } from "@/components/icons";
import { UNDEFINED_DISPLAY, formatNumber } from "@/format/value";
import { formatDateTime, formatTime } from "@/format/datetime";

/** The weather rows, in the reference's order. Slot codes, never Tags. */
const WEATHER_ROWS: { code: string; label: string }[] = [
  { code: "env.irradiance", label: "Irradiance" },
  { code: "env.module_temperature", label: "Module Temp." },
  { code: "env.ambient_temperature", label: "Ambient Temp." },
  { code: "env.wind_speed", label: "Wind Speed" },
  { code: "env.cloud_cover", label: "Cloud Cover" },
];

type Tone = "ok" | "warn" | "bad" | "muted" | "ink" | "faint";

const TONE: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-ink-muted",
  ink: "text-ink",
  faint: "text-ink-faint",
};

interface Row {
  label: string;
  value: ReactNode;
  tone: Tone;
  /** Why the value is what it is — the rule, the source, or why it is blank. */
  title?: string;
  /** A state word (RUNNING) rather than a figure. */
  word?: boolean;
  /** Still being fetched: drawn as a placeholder of the value's size. */
  pending?: boolean;
}

/**
 * A threshold as it was set — "0.5", "0" — not at the magnitude rule's
 * precision, which prints a configured 0.5 as "0.500" and invites the reader
 * to look for a third decimal nobody chose.
 */
function setting(value: number): string {
  return String(value);
}

/** HH:MM in the Plant's zone. Minutes, because the evidence is per-minute. */
function clock(at: string | null, timeZone: string): string {
  return at ? formatTime(at, timeZone).slice(0, 5) : UNDEFINED_DISPLAY;
}

function stateRow(status: OperatingStatus | undefined): Row {
  const label = "Plant Status";
  if (!status) return { label, value: UNDEFINED_DISPLAY, tone: "faint" };
  const { operating } = status;
  const rule =
    `Running once the Inverters' summed AC output rises above ` +
    `${setting(operating.start_above)} ${operating.unit}, until it falls back to ` +
    `${setting(operating.stop_at_or_below)} ${operating.unit}. ` +
    `Σ ${operating.source.device_count} ${operating.source.device_type_code}, ` +
    `${operating.source.reporting} reporting.`;
  switch (operating.state) {
    case "running":
      return { label, value: "Running", tone: "ok", word: true, title: rule };
    case "stopped":
      return { label, value: "Stopped", tone: "muted", word: true, title: rule };
    case "not_started":
      return { label, value: "Not started", tone: "muted", word: true, title: rule };
    case "unknown":
      return {
        label,
        value: "Unknown",
        tone: "warn",
        word: true,
        title: `${operating.undefined_reason ?? "No Inverter is reporting"}. ${rule}`,
      };
    default:
      return {
        label,
        value: UNDEFINED_DISPLAY,
        tone: "faint",
        title: operating.undefined_reason ?? undefined,
      };
  }
}

function gridRow(status: OperatingStatus | undefined): Row {
  const label = "Grid Status";
  if (!status) return { label, value: UNDEFINED_DISPLAY, tone: "faint" };
  const { grid } = status;
  const heard =
    grid.reporting < grid.breakers
      ? ` ${grid.reporting} of ${grid.breakers} breakers reporting; a silent one does not vote.`
      : "";
  const basis = `Read from each ${grid.source.device_type_code}'s ${grid.source.tag_code} contact.${heard}`;
  switch (grid.state) {
    case "connected":
      return { label, value: "Connected", tone: "ok", word: true, title: basis };
    case "disconnected":
      return { label, value: "Disconnected", tone: "bad", word: true, title: basis };
    case "partial":
      return {
        label,
        value: "Partial",
        tone: "warn",
        word: true,
        title: `${grid.closed} breaker(s) closed, ${grid.open} open. ${basis}`,
      };
    case "unknown":
      return {
        label,
        value: "Unknown",
        tone: "warn",
        word: true,
        title: `${grid.undefined_reason ?? "No breaker is reporting"}. ${basis}`,
      };
    default:
      return {
        label,
        value: UNDEFINED_DISPLAY,
        tone: "faint",
        title:
          "No breaker (VCB) is registered at this Plant, so there is no grid status — " +
          "never an assumed \"connected\".",
      };
  }
}

function slotRow(label: string, slot: ResolvedSlot | undefined): Row {
  if (!slot) {
    // Hidden by the server because nothing here is bound to answer it: a Plant
    // with no weather station, which is common and valid.
    return {
      label,
      value: UNDEFINED_DISPLAY,
      tone: "faint",
      title: "No Device at this Plant reports this — there is no weather station bound to it.",
    };
  }
  if (slot.value === null) {
    return { label, value: UNDEFINED_DISPLAY, tone: "faint", title: undefinedExplanation(slot) };
  }
  const source = sourceLabel(slot.source);
  return {
    label,
    value: (
      <>
        {slotText(slot)}
        {slot.unit ? <span className="ml-1 text-xs text-ink-muted">{slot.unit}</span> : null}
      </>
    ),
    tone: "ink",
    title: source
      ? `${source}${slot.source?.tag_code ? ` · ${slot.source.tag_code}` : ""}${
          slot.source?.degraded ? " (fallback source)" : ""
        }`
      : undefined,
  };
}

/** A transition time, "by HH:MM" when it happened in a silence rather than in view. */
function transitionValue(
  at: string | null,
  after: string | null,
  observed: boolean,
  what: "started" | "stopped",
  timeZone: string,
): { value: string; title: string } {
  const time = clock(at, timeZone);
  if (observed) {
    return {
      value: time,
      title: `To the minute: the reading before, at ${clock(after, timeZone)}, had not yet ${what}.`,
    };
  }
  const since = after ? clock(after, timeZone) : "midnight";
  return {
    value: `by ${time}`,
    title:
      `No reading between ${since} and ${time}, so the Plant ${what} somewhere in that gap. ` +
      `${time} is when it was first heard ${what === "started" ? "generating" : "at zero"}.`,
  };
}

function startRow(status: OperatingStatus | undefined, timeZone: string): Row {
  const label = "Plant Start (Today)";
  if (!status) return { label, value: UNDEFINED_DISPLAY, tone: "faint" };
  const { today, operating } = status;
  if (today.start_at) {
    const { value, title } = transitionValue(
      today.start_at, today.start_after, today.start_observed, "started", timeZone,
    );
    return { label, value, tone: "ink", title };
  }
  if (operating.state === "not_started") {
    return {
      label,
      value: "Not yet",
      tone: "muted",
      title: `The Inverters have not risen above ${setting(operating.start_above)} ${operating.unit} today.`,
    };
  }
  return {
    label,
    value: UNDEFINED_DISPLAY,
    tone: "faint",
    title: operating.undefined_reason ?? "No Inverter reading today.",
  };
}

/**
 * Today's stop once the Plant has stopped for the day; otherwise yesterday's,
 * which is what the reference shows while the Plant is running. The label
 * always says which day it is.
 */
function stopRow(status: OperatingStatus | undefined, timeZone: string): Row {
  if (!status) return { label: "Plant Stop", value: UNDEFINED_DISPLAY, tone: "faint" };
  const { today, yesterday, operating } = status;
  if (today.stop_at && operating.state === "stopped") {
    const { value, title } = transitionValue(
      today.stop_at, today.stop_after, today.stop_observed, "stopped", timeZone,
    );
    return { label: "Plant Stop (Today)", value, tone: "ink", title };
  }
  const label = "Plant Stop (Yesterday)";
  return dayStop(label, yesterday, timeZone);
}

function dayStop(label: string, day: OperatingDay, timeZone: string): Row {
  if (day.stop_at) {
    const { value, title } = transitionValue(
      day.stop_at, day.stop_after, day.stop_observed, "stopped", timeZone,
    );
    return { label, value, tone: "ink", title };
  }
  if (day.ended_running) {
    return {
      label,
      value: UNDEFINED_DISPLAY,
      tone: "faint",
      title:
        `Not observed: the Inverters went quiet at ${clock(day.last_sample_at, timeZone)} while ` +
        "still generating, so when the Plant stopped is unknown. Silence is not a stop.",
    };
  }
  return {
    label,
    value: UNDEFINED_DISPLAY,
    tone: "faint",
    title: day.last_sample_at ? "The Plant did not start that day." : "No Inverter reading that day.",
  };
}

function peakRow(status: OperatingStatus | undefined, timeZone: string): Row {
  const label = "Peak Load (Today)";
  if (!status) return { label, value: UNDEFINED_DISPLAY, tone: "faint" };
  const { peak } = status;
  if (peak.value === null) {
    return { label, value: UNDEFINED_DISPLAY, tone: "faint", title: peak.undefined_reason ?? undefined };
  }
  const source = peak.source;
  return {
    label,
    value: (
      <>
        {formatNumber(peak.value)}
        {peak.unit ? <span className="ml-1 text-xs text-ink-muted">{peak.unit}</span> : null}
      </>
    ),
    tone: "ink",
    title:
      `At ${clock(peak.at, timeZone)} — the highest reading today of what Current Power shows` +
      (source
        ? ` (${source.aggregate === "sum" ? `Σ ${source.device_count} ` : ""}` +
          `${source.device_type_code ?? "Device"} · ${source.tag_code}), per minute.`
        : "."),
  };
}

/** One badge for the whole Plant: is anything being heard from it. */
function commBadge(counts: Record<CommStatus, number>): { text: string; tone: Tone; title: string } {
  const known = counts.online + counts.degraded + counts.offline;
  const title =
    `${counts.online} online, ${counts.degraded} degraded, ${counts.offline} offline` +
    (counts.unknown ? `, ${counts.unknown} never heard` : "") +
    " — each judged against its own reporting interval.";
  if (known === 0) return { text: "No data", tone: "muted", title };
  if (counts.online === known) return { text: "Online", tone: "ok", title };
  if (counts.online === 0) return { text: "Offline", tone: "bad", title };
  return { text: `${counts.online} of ${known} online`, tone: "warn", title };
}

const BADGE: Record<Tone, string> = {
  ok: "border-ok/35 bg-ok/10 text-ok",
  warn: "border-warn/35 bg-warn/10 text-warn",
  bad: "border-bad/35 bg-bad/10 text-bad",
  muted: "border-line bg-surface-sunken text-ink-muted",
  ink: "border-line bg-surface-sunken text-ink",
  faint: "border-line bg-surface-sunken text-ink-faint",
};

const DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  muted: "bg-ink-faint",
  ink: "bg-ink",
  faint: "bg-ink-faint",
};

/** The list row both summary cards share, so the two read as one rhythm. */
export function StatusRow({ row }: { row: Row }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-2 last:border-b-0">
      <span className="min-w-0 truncate text-sm text-ink-muted" title={row.label}>
        {row.label}
      </span>
      {row.pending ? (
        <Skeleton className="h-4 w-16 self-center rounded" />
      ) : (
        <span
          className={`shrink-0 whitespace-nowrap ${
            row.word
              ? "text-sm font-semibold uppercase tracking-wide"
              : "figure text-[15px] font-semibold"
          } ${TONE[row.tone]} ${row.title ? "cursor-help" : ""}`}
          title={row.title}
        >
          {row.value}
        </span>
      )}
    </div>
  );
}
export type { Row as StatusRowData, Tone as StatusTone };

/** The header both summary cards share: a title and the way into the detail. */
export function cardHeading({
  title,
  onOpen,
  openLabel,
}: {
  title: string;
  onOpen: () => void;
  openLabel: string;
}): { title: ReactNode; actions: ReactNode } {
  return {
    title: <span className="text-lg">{title}</span>,
    actions: (
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={openLabel}
        className="flex h-8 w-8 items-center justify-center rounded-control border border-line text-ink-muted transition hover:border-accent/50 hover:text-accent"
      >
        <IconChevronRight size={15} />
      </button>
    ),
  };
}

export function PlantStatusCard({
  status,
  isLoading,
  environment,
  devices,
  health,
  timeZone,
  onOpen,
  className = "",
}: {
  status: OperatingStatus | undefined;
  isLoading: boolean;
  /** The `environment` panel's slots, as the server resolved them. */
  environment: ResolvedSlot[];
  devices: DeviceListItem[];
  health: Record<CommStatus, number>;
  timeZone: string;
  onOpen: () => void;
  className?: string;
}): JSX.Element {
  const bySlot = new Map(environment.map((slot) => [slot.slot_code, slot]));
  const pending = isLoading && !status;
  const derived = (row: Row): Row => ({ ...row, pending });
  const rows: Row[] = [
    derived(stateRow(status)),
    derived(gridRow(status)),
    ...WEATHER_ROWS.map(({ code, label }) => slotRow(label, bySlot.get(code))),
    derived(startRow(status, timeZone)),
    derived(stopRow(status, timeZone)),
    derived(peakRow(status, timeZone)),
  ];
  const badge = commBadge(health);
  // When anything at the Plant was last heard. The Plant KPI panel is written
  // by the scheduler, not heard from the site, so it has no say here.
  const lastHeard = devices.reduce<string | null>((latest, device) => {
    if (!device.last_seen_at || device.type_code === "PLANT_KPI") return latest;
    return latest === null || Date.parse(device.last_seen_at) > Date.parse(latest)
      ? device.last_seen_at
      : latest;
  }, null);

  return (
    <Panel
      fill
      padding="px-4 pb-4 pt-1"
      className={className}
      {...cardHeading({ title: "Plant Status", onOpen, openLabel: "Everything behind Plant Status" })}
    >
      <div className="flex h-full flex-col">
        <div>
          {rows.map((row) => (
            <StatusRow key={row.label} row={row} />
          ))}
        </div>
        <div className="mt-auto pt-4">
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${BADGE[badge.tone]}`}
            title={badge.title}
          >
            <span className={`h-2 w-2 rounded-full ${DOT[badge.tone]}`} />
            {badge.text}
          </span>
          <p
            className="mt-2 text-xs text-ink-faint"
            title="The latest message received from any Device at this Plant, in the Plant's time."
          >
            Last updated: {lastHeard ? formatDateTime(lastHeard, timeZone) : UNDEFINED_DISPLAY}
          </p>
        </div>
      </div>
    </Panel>
  );
}

/**
 * The drawer behind the card: the rules the derived rows were decided by, in
 * words, with both days side by side. What the card cannot fit is *why*.
 */
export function OperatingDetail({
  status,
  timeZone,
}: {
  status: OperatingStatus | undefined;
  timeZone: string;
}): JSX.Element {
  if (!status) {
    return <p className="text-xs text-ink-faint">The operating status could not be loaded.</p>;
  }
  const { operating, today, yesterday, peak, grid } = status;
  const day = (label: string, value: OperatingDay) => {
    const start = value.start_at
      ? transitionValue(value.start_at, value.start_after, value.start_observed, "started", timeZone)
      : null;
    const stop = value.stop_at
      ? transitionValue(value.stop_at, value.stop_after, value.stop_observed, "stopped", timeZone)
      : null;
    return (
      <tr className="border-b border-line-soft last:border-b-0">
        <td className="py-1.5 text-ink-muted">{label}</td>
        <td className="figure py-1.5 text-right text-ink" title={start?.title}>
          {start?.value ?? UNDEFINED_DISPLAY}
        </td>
        <td
          className="figure py-1.5 text-right text-ink"
          title={stop?.title ?? dayStop(label, value, timeZone).title}
        >
          {stop?.value ?? UNDEFINED_DISPLAY}
        </td>
      </tr>
    );
  };
  return (
    <div className="space-y-3 text-xs leading-snug text-ink-muted">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-ink-faint">
            <th className="pb-1 text-left font-medium">Day</th>
            <th className="pb-1 text-right font-medium">Start</th>
            <th className="pb-1 text-right font-medium">Stop</th>
          </tr>
        </thead>
        <tbody>
          {day("Today", today)}
          {day("Yesterday", yesterday)}
        </tbody>
      </table>
      <p>
        <strong className="text-ink">Start</strong> is the first minute of the Plant's day in which
        the Inverters' summed AC output rose above {setting(operating.start_above)}{" "}
        {operating.unit}. <strong className="text-ink">Stop</strong> is the minute it fell back to{" "}
        {setting(operating.stop_at_or_below)} {operating.unit}; a restart later the same day
        takes the stop back, so the day's last fall is the one that stands. "by 13:55" means the
        change happened in a silence and 13:55 is when it was first heard.
      </p>
      <p>
        <strong className="text-ink">Peak load</strong> is the highest per-minute reading today of
        what Current Power shows
        {peak.source
          ? ` — ${peak.source.device_type_code ?? "Device"} ${peak.source.tag_code}`
          : ""}
        {peak.at ? `, at ${clock(peak.at, timeZone)}` : ""}.
      </p>
      <p>
        <strong className="text-ink">Grid status</strong> is read from the{" "}
        {grid.source.device_type_code} {grid.source.tag_code} contact: {grid.breakers} breaker(s)
        registered, {grid.reporting} reporting, {grid.closed} closed, {grid.open} open. A breaker
        that has gone quiet does not vote on its last contact.
      </p>
      <p className="text-ink-faint">
        From {operating.resolution} history of {operating.source.device_count}{" "}
        {operating.source.device_type_code} ({operating.source.reporting} reporting now)
        {operating.flagged_buckets > 0
          ? `; ${operating.flagged_buckets} minute(s) holding a flagged reading were left out`
          : ""}
        . Every threshold is set in the backend's assumptions and is provisional.
      </p>
    </div>
  );
}
