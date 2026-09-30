/**
 * `string_analysis` — every PV string of every Inverter at once, coloured by
 * what it is doing. The client's reference screen (30 Sep 2026): a heatmap of
 * Inverter × string, and one Inverter's strings in detail below it.
 *
 * ── Where the colours come from ─────────────────────────────────────────────
 * Not from here. `GET /plants/{id}/strings` returns each string's latest
 * current *and its verdict* (`domain/strings.py`), because the verdict rests on
 * an assumed threshold and an assumed threshold may not live outside
 * `assumptions.py` (Guardrail 6). The screen arranges; it never judges. The
 * rule is echoed back under `rule` and printed beside the heatmap, marked
 * proposed — the client has supplied no rule for string health.
 *
 * ── Five states, and the two that look alike ────────────────────────────────
 * "No current" is said only while the Inverter is generating; the same zero at
 * night is "Idle", or every string would be red after sunset. "No reading" is
 * never drawn as a zero (Guardrail 23): its cell is an empty outline, and its
 * tooltip says which blank it is — unbound, silent, stale or only flagged
 * readings (Guardrail 26). A string count nobody recorded is said on the row.
 *
 * The header counts faults only among strings that could be judged, and says
 * so when none could: "0 weak strings" at midnight would be a zero nobody
 * measured.
 *
 * On Guardrail 2: this filters on the `INVERTER` Device *Type* server-side, a
 * catalogue row, the way Inverter Monitoring does.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePlant, usePlantDevices, usePlantStrings } from "@/api/hooks";
import type {
  DeviceListItem,
  InverterStrings,
  PlantStrings,
  PvString,
  StringCounts,
  StringState,
} from "@/api/schemas";
import { Badge, Drawer, Panel, SelectBox, type BadgeTone } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonPanel } from "@/components/state";
import { CommStatusPill, PlantPicker } from "@/components/domain";
import { DeviceInspector } from "@/components/devices/DeviceInspector";
import { InverterHeadline, InverterView } from "@/components/devices/InverterView";
import { IconChevronLeft, IconChevronRight } from "@/components/icons";
import { usePermission } from "@/auth/usePermission";
import { useLiveSocket } from "@/live/LiveSocket";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { DEFAULT_TIMEZONE, formatTime, timezoneLabel } from "@/format/datetime";
import { formatNumber, formatValue } from "@/format/value";

// ── The five states ─────────────────────────────────────────────────────────

/**
 * How each state is drawn. Status owns green, amber and red on this platform,
 * and each of these *is* a verdict — but "normal" is the pale one, so a Plant
 * with nothing wrong reads as quiet rather than as a wall of green, and the
 * faults differ from it in lightness as well as hue (a red–green confusion
 * cannot hide one). "No current" also carries a mark, for the same reason.
 */
const STATE: Record<StringState, { word: string; cell: string; bar: string; frame: string }> = {
  no_current: {
    word: "No current",
    cell: "bg-bad border-bad",
    bar: "bg-bad",
    frame: "border-bad/50",
  },
  low: { word: "Low current", cell: "bg-warn border-warn", bar: "bg-warn", frame: "border-warn/50" },
  normal: { word: "Normal", cell: "bg-ok/35 border-ok/40", bar: "bg-chart", frame: "border-line" },
  idle: { word: "Idle", cell: "bg-ink-faint/25 border-transparent", bar: "bg-ink-faint", frame: "border-line" },
  no_reading: {
    word: "No reading",
    cell: "border-dashed border-line-strong bg-transparent",
    bar: "bg-ink-faint",
    frame: "border-line",
  },
};

const LEGEND: { state: StringState; label: string }[] = [
  { state: "normal", label: "Normal" },
  { state: "low", label: "Low current" },
  { state: "no_current", label: "No current (generating)" },
  { state: "idle", label: "Idle" },
  { state: "no_reading", label: "No reading" },
];

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The header's verdict. Faults are counted only among strings that could be
 * judged, and when none could the pill says so rather than printing a zero.
 */
export function stringSummary(counts: StringCounts): { text: string; tone: BadgeTone; title: string } {
  const judged = counts.normal + counts.low + counts.no_current;
  if (counts.no_current > 0) {
    return {
      text: [
        plural(counts.no_current, "string without current", "strings without current"),
        counts.low > 0 ? plural(counts.low, "low", "low") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: "bad",
      title: "No current on a string while its Inverter is generating.",
    };
  }
  if (counts.low > 0) {
    return {
      text: plural(counts.low, "low string", "low strings"),
      tone: "warn",
      title: "Carrying current, but well below the other strings on the same Inverter.",
    };
  }
  if (judged > 0) {
    return {
      text: "No low or dead strings",
      tone: "neutral",
      title: `${plural(judged, "string", "strings")} judged; every one within range.`,
    };
  }
  if (counts.idle > 0) {
    return {
      text: "Not generating — nothing to judge",
      tone: "neutral",
      title: "Every string with a reading is idle because its Inverter is not generating.",
    };
  }
  if (counts.no_reading > 0) {
    return {
      text: "No string readings",
      tone: "neutral",
      title: "No string has a recent reading, so none can be judged.",
    };
  }
  return {
    text: "No strings recorded",
    tone: "neutral",
    title: "No Inverter here has a string count recorded, so there are no strings to judge.",
  };
}

/** Natural order, so INV_2 comes before INV_10. */
export function byCode(a: { code: string }, b: { code: string }): number {
  return a.code.localeCompare(b.code, undefined, { numeric: true });
}

/** A bar's length: this string against the strongest string on the same Inverter. */
export function barFraction(value: number | null, strongest: number | null): number {
  if (value === null || strongest === null || strongest <= 0) return 0;
  return Math.max(0, Math.min(1, value / strongest));
}

const OPERATING_WORD: Record<string, string> = {
  running: "Generating",
  stopped: "Stopped",
  not_started: "Not started",
  unknown: "Unknown",
};

const operatingWord = (inverter: InverterStrings) =>
  inverter.operating.state ? (OPERATING_WORD[inverter.operating.state] ?? inverter.operating.state) : "Unknown";

// ── Heatmap ─────────────────────────────────────────────────────────────────

function cellTitle(inverter: InverterStrings, string: PvString, unit: string): string {
  const value = string.current === null ? "" : ` · ${formatValue(string.current, unit, { digits: 2 })}`;
  return `${inverter.code} · String ${string.n}${value} · ${STATE[string.state].word}\n${string.reason}`;
}

function Cell({
  inverter,
  string,
  unit,
  onSelect,
}: {
  inverter: InverterStrings;
  string: PvString;
  unit: string;
  onSelect: () => void;
}): JSX.Element {
  const title = cellTitle(inverter, string, unit);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      aria-label={title}
      data-testid={`cell-${inverter.device_id}-${string.n}`}
      data-state={string.state}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] border transition hover:scale-110 focus-visible:scale-110 ${STATE[string.state].cell}`}
    >
      {string.state === "no_current" ? (
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-surface" aria-hidden>
          <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : null}
    </button>
  );
}

function RowSummary({ inverter }: { inverter: InverterStrings }): JSX.Element {
  const { counts } = inverter;
  const faults = [
    counts.no_current > 0 ? { text: `${counts.no_current} no current`, className: "text-bad" } : null,
    counts.low > 0 ? { text: `${counts.low} low`, className: "text-warn" } : null,
  ].filter((item): item is { text: string; className: string } => item !== null);
  return (
    <span className="text-xs text-ink-muted">
      {faults.length > 0
        ? faults.map((fault, index) => (
            <span key={fault.text} className={`font-semibold ${fault.className}`}>
              {index > 0 ? " · " : ""}
              {fault.text}
            </span>
          ))
        : operatingWord(inverter)}
    </span>
  );
}

export function Heatmap({
  data,
  selectedId,
  onSelect,
  canManage,
}: {
  data: PlantStrings;
  selectedId: number | null;
  onSelect: (deviceId: number, n: number | null) => void;
  canManage: boolean;
}): JSX.Element {
  const unit = data.units.current;
  const inverters = [...data.inverters].sort(byCode);
  const uncounted = inverters.filter((inverter) => inverter.strings.length === 0).length;
  return (
    <div className="space-y-1.5">
      {uncounted > 0 ? (
        // Guardrail 26, said once: twelve rows repeating the same sentence is
        // a page nobody reads. Each row keeps the server's reason on hover.
        <p className="mb-2 rounded-control border border-line bg-surface-sunken px-3 py-2 text-xs leading-snug text-ink-muted">
          {uncounted === inverters.length
            ? `No Inverter here has a string count recorded`
            : `${uncounted} of ${inverters.length} Inverters have no string count recorded`}
          , so which of {uncounted === 1 ? "its" : "their"} PV inputs are real strings is not known and there is nothing to
          draw for {uncounted === 1 ? "it" : "them"} — not strings that have gone quiet. Record the count
          under Tag Mapping, and bind the PV keys there if they are not bound already.
        </p>
      ) : null}
      {inverters.map((inverter) => {
        const selected = inverter.device_id === selectedId;
        return (
          <div
            key={inverter.device_id}
            data-testid={`row-${inverter.device_id}`}
            className={`flex flex-col gap-2 rounded-control px-2 py-1.5 sm:flex-row sm:items-center sm:gap-4 ${
              selected ? "bg-accent/10" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(inverter.device_id, null)}
              aria-pressed={selected}
              className="flex min-w-0 shrink-0 flex-col items-start text-left sm:w-44"
            >
              <span className={`truncate font-mono text-sm ${selected ? "font-semibold text-accent" : "text-ink"}`}>
                {inverter.code}
              </span>
              <RowSummary inverter={inverter} />
            </button>
            {inverter.strings.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {inverter.strings.map((string) => (
                  <Cell
                    key={string.n}
                    inverter={inverter}
                    string={string}
                    unit={unit}
                    onSelect={() => onSelect(inverter.device_id, string.n)}
                  />
                ))}
              </div>
            ) : (
              // Guardrail 26: an empty row says why, and where it is fixed.
              <p
                className="flex-1 text-xs leading-snug text-ink-muted"
                title={inverter.undefined_reason ?? undefined}
                data-testid={`no-strings-${inverter.device_id}`}
              >
                {inverter.string_count ? "No PV strings reported." : "No string count recorded."}{" "}
                {canManage ? (
                  <Link
                    to={`/admin/bindings?device=${inverter.device_id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    Record it in Tag Mapping
                  </Link>
                ) : null}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
      {LEGEND.map(({ state, label }) => (
        <li key={state} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 rounded-[2px] border ${STATE[state].cell}`} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}

// ── One Inverter's strings ──────────────────────────────────────────────────

/** An Inverter's entry in the switcher: its code, then its faults, so a dead string is findable from the list. */
export function switcherLabel(inverter: InverterStrings): string {
  const { counts } = inverter;
  const faults = [
    counts.no_current > 0 ? `${counts.no_current} no current` : null,
    counts.low > 0 ? `${counts.low} low` : null,
  ].filter(Boolean);
  return faults.length > 0 ? `${inverter.code} — ${faults.join(" · ")}` : inverter.code;
}

/**
 * Step through the Inverters from the panel itself. The heatmap above already
 * selects, but on a Plant with a dozen Inverters it scrolls out of sight
 * while you read the tiles, and nothing on the panel said it could change.
 */
export function InverterSwitcher({
  inverters,
  selectedId,
  onSelect,
}: {
  /** Already in display order. */
  inverters: InverterStrings[];
  selectedId: number;
  onSelect: (deviceId: number) => void;
}): JSX.Element | null {
  const index = inverters.findIndex((inverter) => inverter.device_id === selectedId);
  const current = inverters[index];
  if (!current || inverters.length < 2) return null;
  const previous = inverters[index - 1] ?? null;
  const next = inverters[index + 1] ?? null;
  const step = (target: InverterStrings | null, direction: "Previous" | "Next") => (
    <button
      type="button"
      disabled={!target}
      onClick={() => target && onSelect(target.device_id)}
      aria-label={target ? `${direction} Inverter, ${target.code}` : `No ${direction.toLowerCase()} Inverter`}
      title={target ? target.code : undefined}
      className="flex items-center rounded-control border border-line px-2 text-ink-muted transition hover:border-accent/50 hover:text-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {direction === "Previous" ? <IconChevronLeft size={14} /> : <IconChevronRight size={14} />}
    </button>
  );
  return (
    <div className="flex items-stretch gap-1" data-testid="inverter-switcher">
      {step(previous, "Previous")}
      <SelectBox
        size="sm"
        value={String(current.device_id)}
        onChange={(value) => onSelect(Number(value))}
        className="min-w-[11rem]"
        display={
          <>
            <span className="font-mono">{current.code}</span>
            <span className="ml-1.5 font-normal text-ink-muted">
              {index + 1} of {inverters.length}
            </span>
          </>
        }
      >
        {inverters.map((inverter) => (
          <option key={inverter.device_id} value={inverter.device_id}>
            {switcherLabel(inverter)}
          </option>
        ))}
      </SelectBox>
      {step(next, "Next")}
    </div>
  );
}

function StringTile({
  string,
  units,
  strongest,
  median,
  highlighted,
}: {
  string: PvString;
  units: PlantStrings["units"];
  strongest: number | null;
  median: number | null;
  highlighted: boolean;
}): JSX.Element {
  const style = STATE[string.state];
  const fraction = barFraction(string.current, strongest);
  const medianAt = barFraction(median, strongest);
  const extra = [
    string.voltage !== null && units.voltage ? formatValue(string.voltage, units.voltage) : null,
    string.power !== null && units.power ? formatValue(string.power, units.power) : null,
  ].filter(Boolean);
  return (
    <div
      data-testid={`string-tile-${string.n}`}
      title={string.reason}
      className={`surface-tile rounded-card border px-3 py-2.5 ${style.frame} ${
        highlighted ? "ring-2 ring-accent" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-muted">String {String(string.n).padStart(2, "0")}</span>
        {string.state !== "normal" ? (
          <span
            className={`text-[11px] font-semibold ${
              string.state === "no_current" ? "text-bad" : string.state === "low" ? "text-warn" : "text-ink-faint"
            }`}
          >
            {style.word}
          </span>
        ) : null}
      </div>
      <div className={`figure mt-0.5 text-lg font-semibold ${string.current === null ? "text-ink-faint" : "text-ink"}`}>
        {formatNumber(string.current, { digits: 2 })}
        {string.current !== null ? <span className="ml-1 text-xs font-normal text-ink-muted">{units.current}</span> : null}
      </div>
      <div className="relative mt-1.5 h-1.5 rounded-full bg-surface-sunken">
        <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${fraction * 100}%` }} />
        {median !== null ? (
          <div
            className="absolute -top-0.5 h-2.5 w-px bg-ink-muted"
            style={{ left: `${medianAt * 100}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-1 truncate text-[11px] text-ink-faint">{extra.length > 0 ? extra.join(" · ") : " "}</div>
    </div>
  );
}

function InverterDetail({
  inverter,
  units,
  highlightedString,
  timeZone,
  switcher,
  onOpen,
}: {
  inverter: InverterStrings;
  units: PlantStrings["units"];
  highlightedString: number | null;
  timeZone: string;
  switcher: ReactNode;
  onOpen: () => void;
}): JSX.Element {
  const strongest = inverter.strings.reduce<number | null>(
    (best, string) => (string.current !== null && (best === null || string.current > best) ? string.current : best),
    null,
  );
  const median = inverter.median_current;
  const lastAt = inverter.strings.reduce<string | null>(
    (latest, string) => (string.at && (!latest || string.at > latest) ? string.at : latest),
    null,
  );
  return (
    <Panel
      title={
        <span className="text-base">
          <span className="font-mono">{inverter.code}</span>
          {inverter.name && inverter.name !== inverter.code ? (
            <span className="ml-2 font-normal text-ink-muted">{inverter.name}</span>
          ) : null}
        </span>
      }
      subtitle={
        <span className="text-sm">
          {operatingWord(inverter)}
          {inverter.operating.undefined_reason ? ` (${inverter.operating.undefined_reason})` : ""}
          {inverter.string_count ? ` · ${plural(inverter.string_count, "string", "strings")}` : ""}
          {median !== null
            ? ` · median of producing strings ${formatValue(median, units.current, { digits: 2 })}, the tick on each bar`
            : ""}
          {lastAt ? ` · last reading ${formatTime(lastAt, timeZone)}` : ""}
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {switcher}
          <CommStatusPill status={inverter.comm_status} />
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-control border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
          >
            Open Inverter
            <IconChevronRight size={13} />
          </button>
        </div>
      }
    >
      {inverter.strings.length === 0 ? (
        <p className="text-sm leading-snug text-ink-muted">
          {inverter.undefined_reason ?? "This Inverter reports no PV strings."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
          {inverter.strings.map((string) => (
            <StringTile
              key={string.n}
              string={string}
              units={units}
              strongest={strongest}
              median={median}
              highlighted={string.n === highlightedString}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

export function StringAnalysisDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const stringsQuery = usePlantStrings(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const { devices: liveDevices } = useLiveSocket();
  const canManage = usePermission("config.modify");
  const timezone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;

  /** The Inverter below the heatmap. `null` means "the first", so a Plant switch never strands a stale id. */
  const [chosen, setChosen] = useState<{ deviceId: number; n: number | null } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  const data = stringsQuery.data;
  const inverters = useMemo(() => [...(data?.inverters ?? [])].sort(byCode), [data]);
  const selected = inverters.find((inverter) => inverter.device_id === chosen?.deviceId) ?? inverters[0] ?? null;
  const deviceById = useMemo(
    () => new Map((devicesQuery.data ?? []).map((device) => [device.id, device])),
    [devicesQuery.data],
  );
  const selectedDevice: DeviceListItem | null = selected ? (deviceById.get(selected.device_id) ?? null) : null;

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const maxStrings = inverters.reduce((most, inverter) => Math.max(most, inverter.string_count ?? 0), 0);
  const summary = data ? stringSummary(data.counts) : null;

  const header = (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="page-title">String Analysis</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {data && inverters.length > 0 ? (
            <>
              {plural(inverters.length, "Inverter", "Inverters")}
              {maxStrings > 0 ? ` × up to ${maxStrings} strings` : ""} · as of{" "}
              <span className="figure text-ink">{formatTime(data.as_of, timezone)}</span>
              <span className="text-ink-faint"> · {timezoneLabel(timezone)} time</span>
            </>
          ) : (
            "Every PV string of every Inverter: which carry current, which are low, which carry none."
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
        {summary && inverters.length > 0 ? (
          <span title={summary.title} data-testid="string-summary">
            <Badge tone={summary.tone}>
              <span className="px-1 py-0.5 text-sm">{summary.text}</span>
            </Badge>
          </span>
        ) : null}
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
      </div>
    </header>
  );

  if (stringsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <SkeletonPanel />
        <SkeletonPanel />
      </div>
    );
  }
  if (stringsQuery.isError || !data) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState error={stringsQuery.error} retry={() => void stringsQuery.refetch()} />
      </div>
    );
  }
  if (inverters.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {/* Guardrail 26: say which blank this is. */}
        <EmptyState
          title="No Inverters at this Plant"
          detail="No Device of type INVERTER is registered here, so there are no PV strings to show — not strings that have gone quiet."
        />
      </div>
    );
  }

  const { rule } = data;
  const ruleText =
    `Low: more than ${Math.round(rule.low_below_median_fraction * 100)}% below the median of the same ` +
    `Inverter's producing strings, compared only while it is generating and that median is at least ` +
    `${formatValue(rule.min_median, data.units.current)}. Latest value in the last ${rule.lookback_minutes} ` +
    `minutes. ⚠ Proposed — the client has supplied no rule for string health.`;

  return (
    <div className="flex flex-col gap-6">
      {header}

      <Panel
        title={<span className="text-base">Inverter × string</span>}
        subtitle={
          <span className="text-sm">
            <span className="block text-ink">Choose an Inverter or any string to show its strings below.</span>
            {ruleText}
          </span>
        }
        actions={<Legend />}
      >
        <Heatmap
          data={data}
          selectedId={selected?.device_id ?? null}
          onSelect={(deviceId, n) => setChosen({ deviceId, n })}
          canManage={canManage}
        />
      </Panel>

      {selected ? (
        <InverterDetail
          inverter={selected}
          units={data.units}
          highlightedString={chosen?.deviceId === selected.device_id ? chosen.n : null}
          timeZone={timezone}
          switcher={
            <InverterSwitcher
              inverters={inverters}
              selectedId={selected.device_id}
              onSelect={(deviceId) => setChosen({ deviceId, n: null })}
            />
          }
          onOpen={() => {
            setShowInspector(false);
            setDrawerOpen(true);
          }}
        />
      ) : null}

      <Drawer
        open={drawerOpen && selectedDevice !== null}
        onClose={() => setDrawerOpen(false)}
        size={showInspector ? "narrow" : "wide"}
        title={
          selectedDevice ? (
            <>
              <span className="font-mono">{selectedDevice.code}</span>
              {selectedDevice.name && selectedDevice.name !== selectedDevice.code ? (
                <span className="ml-2 font-normal text-ink-muted">{selectedDevice.name}</span>
              ) : null}
            </>
          ) : (
            ""
          )
        }
        subtitle={
          selectedDevice && !showInspector ? (
            <InverterHeadline
              device={selectedDevice}
              plantName={plantQuery.data?.name ?? null}
              clientName={plantQuery.data?.client_name ?? null}
              timeZone={timezone}
            />
          ) : undefined
        }
        footer={
          selectedDevice ? (
            <button
              type="button"
              onClick={() => setShowInspector((shown) => !shown)}
              className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
            >
              {showInspector
                ? "Back to the Inverter view"
                : "Every Tag, its binding, the topic and the wiring — the Device inspector"}
              <IconChevronRight size={13} />
            </button>
          ) : null
        }
      >
        {selectedDevice && showInspector ? (
          <DeviceInspector
            device={selectedDevice}
            values={liveDevices[selectedDevice.id]?.values}
            timezone={timezone}
            deviceLookup={deviceById}
          />
        ) : selectedDevice ? (
          <InverterView
            key={selectedDevice.id}
            device={selectedDevice}
            live={liveDevices[selectedDevice.id]?.values}
            timeZone={timezone}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
