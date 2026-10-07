/**
 * A custom report: any readings from any of the reader's Plants' Devices, over
 * a period, at the interval they choose — built in three choices and saved for
 * everyone in the Client to reuse.
 *
 *   1. Plants      one or more
 *   2. Devices     ticked one by one, or a whole group ("all 17 Inverters")
 *   3. Readings    whatever the chosen Devices actually send
 *
 * then the period and the interval. The preview runs by itself as choices are
 * made (after a short pause, so ticking ten boxes is one request, not ten),
 * and every download is computed afresh on the server from the same
 * definition (`services/custom_reports`).
 *
 * What it never does: offer a reading a Device does not send, fill a gap with
 * zero, or run a report too large to read — the server refuses that with a
 * sentence saying what to change, and the sentence is shown as it is.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as reportsApi from "@/api/endpoints/reports";
import type {
  CatalogDevice,
  CustomAggregation,
  CustomReportDefinition,
  ReportFormat,
  ReportPeriod,
  SavedReport,
} from "@/api/endpoints/reports";
import type { MePlant } from "@/api/schemas";
import { triggerDownload } from "@/api/client";
import { isApiError } from "@/api/problem";
import { useDebouncedValue } from "@/state/useDebouncedValue";
import { Button, Panel, SegmentedControl } from "@/components/ui";
import { IconChevronDown, IconExport } from "@/components/icons";
import { DEFAULT_TIMEZONE, toDateTimeInput } from "@/format/datetime";
import { customRangeEnd, customRangeProblem, type CustomRange } from "./format";
import { printHtml } from "./printHtml";
import { ReportPreview } from "./ReportPreview";
import { MAX_CUSTOM_DAYS, ReportPeriodPicker } from "./ReportPeriodPicker";

/** The server's own limit on columns (`CustomReportDefinition.series`). */
const MAX_COLUMNS = 60;

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 1, label: "1 min" },
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "1 day" },
];

const AGGREGATIONS: { value: CustomAggregation; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    hint: "Each reading summarised the way it is meant to be: a counter at its last reading, power and temperature as the average.",
  },
  { value: "avg", label: "Average", hint: "The average over each interval." },
  { value: "min", label: "Lowest", hint: "The lowest reading in each interval." },
  { value: "max", label: "Highest", hint: "The highest reading in each interval." },
  { value: "last", label: "Last", hint: "The last reading in each interval." },
  {
    value: "change",
    label: "Change",
    hint: "How far a counter moved in each interval — energy per interval from an energy counter. Other readings keep their usual summary.",
  },
];

const FORMATS: { format: ReportFormat; label: string; hint: string }[] = [
  { format: "csv", label: "CSV", hint: "The rows only — opens as a table anywhere." },
  { format: "xlsx", label: "Excel", hint: "The table, with its period and notes." },
  { format: "pdf", label: "PDF", hint: "A printable page of the table and its notes." },
];

type Notice = { tone: "info" | "bad" | "ok"; text: string };

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const boxClass =
  "rounded-card border border-line bg-surface-sunken";
const searchClass =
  "h-8 w-full rounded-control border border-line bg-surface-raised px-2.5 text-xs text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
const smallField =
  "h-8 rounded-control border border-line bg-surface-raised px-2 text-xs text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

interface DeviceGroup {
  key: string;
  plantId: number;
  plantCode: string;
  typeName: string;
  devices: CatalogDevice[];
}

function asDefinition(value: unknown): CustomReportDefinition | null {
  if (!value || typeof value !== "object") return null;
  const definition = value as CustomReportDefinition;
  return Array.isArray(definition.series) ? definition : null;
}

export function CustomReportBuilder({
  plants,
  startPlantId,
}: {
  plants: MePlant[];
  startPlantId: number | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [plantIds, setPlantIds] = useState<number[]>(startPlantId !== null ? [startPlantId] : []);
  const [deviceIds, setDeviceIds] = useState<Set<number>>(new Set());
  const [tagCodes, setTagCodes] = useState<Set<string>>(new Set());
  const [deviceSearch, setDeviceSearch] = useState("");
  /** Device groups the reader opened or closed against their default. */
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [readingSearch, setReadingSearch] = useState("");
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [range, setRange] = useState<CustomRange>({
    fromDate: "",
    fromTime: "00:00",
    toDate: "",
    toTime: "23:59",
  });
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [customInterval, setCustomInterval] = useState(false);
  const [aggregation, setAggregation] = useState<CustomAggregation>("auto");
  const [savedId, setSavedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // ── What can be chosen ────────────────────────────────────────────────────
  const sortedPlantIds = useMemo(() => [...plantIds].sort((a, b) => a - b), [plantIds]);
  const catalogQuery = useQuery({
    queryKey: qk.customCatalog(sortedPlantIds),
    queryFn: () => reportsApi.customCatalog(sortedPlantIds),
    enabled: sortedPlantIds.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const savedQuery = useQuery({
    queryKey: qk.savedReports(),
    queryFn: reportsApi.listSavedReports,
    staleTime: 60_000,
    retry: false,
  });
  const catalog = catalogQuery.data;
  // INVERTER_2 before INVERTER_10, as people count them.
  const devices = useMemo(
    () =>
      (catalog?.devices ?? [])
        .filter((device) => sortedPlantIds.includes(device.plant_id))
        .sort((a, b) => a.plant_id - b.plant_id || natural(a.code, b.code)),
    [catalog, sortedPlantIds],
  );
  const plantCode = useMemo(
    () => new Map((catalog?.plants ?? []).map((plant) => [plant.id, plant.code])),
    [catalog],
  );
  const zone =
    catalog?.plants.find((plant) => plant.id === sortedPlantIds[0])?.timezone ?? DEFAULT_TIMEZONE;
  const now = toDateTimeInput(Date.now(), zone);

  const groups = useMemo<DeviceGroup[]>(() => {
    const byKey = new Map<string, DeviceGroup>();
    for (const device of devices) {
      const key = `${device.plant_id}|${device.type_code}`;
      const group = byKey.get(key) ?? {
        key,
        plantId: device.plant_id,
        plantCode: plantCode.get(device.plant_id) ?? String(device.plant_id),
        typeName: device.type_name,
        devices: [],
      };
      group.devices.push(device);
      byKey.set(key, group);
    }
    for (const group of byKey.values()) group.devices.sort((a, b) => natural(a.code, b.code));
    return [...byKey.values()].sort(
      (a, b) => natural(a.plantCode, b.plantCode) || a.typeName.localeCompare(b.typeName),
    );
  }, [devices, plantCode]);

  const chosenDevices = useMemo(
    () => devices.filter((device) => deviceIds.has(device.id)),
    [devices, deviceIds],
  );

  /** Every reading the chosen Devices send, with how many of them send it. */
  const readings = useMemo(() => {
    const byCode = new Map<string, { code: string; name: string; unit: string | null; count: number }>();
    for (const device of chosenDevices) {
      for (const tag of device.tags) {
        const entry = byCode.get(tag.code) ?? { code: tag.code, name: tag.name, unit: tag.unit, count: 0 };
        entry.count += 1;
        byCode.set(tag.code, entry);
      }
    }
    return [...byCode.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [chosenDevices]);

  // ── The definition ────────────────────────────────────────────────────────
  // Reading first, then Device: the same reading from seventeen Inverters sits
  // side by side, which is what a comparison across them needs.
  const series = useMemo(() => {
    const codes = readings.filter((reading) => tagCodes.has(reading.code)).map((reading) => reading.code);
    return codes.flatMap((code) =>
      chosenDevices
        .filter((device) => device.tags.some((tag) => tag.code === code))
        .map((device) => ({ device_id: device.id, tag_code: code })),
    );
  }, [readings, tagCodes, chosenDevices]);

  const rangeProblem = period === "custom" ? customRangeProblem(range, now, MAX_CUSTOM_DAYS) : null;
  const tooMany = series.length > MAX_COLUMNS;
  const definition: CustomReportDefinition | null =
    series.length > 0 && !tooMany && rangeProblem === null && intervalMinutes >= 1
      ? {
          name: name.trim() || null,
          plant_ids: sortedPlantIds,
          series,
          interval_minutes: intervalMinutes,
          aggregation,
          period,
          ...(period === "custom"
            ? {
                from_date: range.fromDate,
                to_date: range.toDate,
                from_time: range.fromTime,
                to_time: range.toTime,
              }
            : {}),
        }
      : null;
  // One request after the ticking stops, not one per box. Compared as text:
  // the definition is a fresh object on every render.
  const definitionKey = definition ? JSON.stringify(definition) : null;
  const settledKey = useDebouncedValue(definitionKey, 450);
  const settled = useMemo<CustomReportDefinition | null>(
    () => (settledKey ? (JSON.parse(settledKey) as CustomReportDefinition) : null),
    [settledKey],
  );
  const live = period !== "yesterday" && (period !== "custom" || customRangeEnd(range) > now);
  const tableQuery = useQuery({
    queryKey: qk.customTable(settled),
    queryFn: () => reportsApi.customTable(settled as CustomReportDefinition),
    enabled: settled !== null,
    retry: false,
    placeholderData: (previous) => previous,
    refetchInterval: live ? 60_000 : false,
  });
  const table = settled ? tableQuery.data : undefined;
  const stale = tableQuery.isPlaceholderData || settledKey !== definitionKey;

  // ── Saved reports ─────────────────────────────────────────────────────────
  const saved = savedQuery.data ?? [];
  const current = saved.find((report) => report.id === savedId) ?? null;

  const open = (report: SavedReport | null) => {
    setNotice(null);
    if (!report) {
      setSavedId(null);
      setName("");
      return;
    }
    const loaded = asDefinition(report.definition);
    if (!loaded) {
      setNotice({ tone: "bad", text: "This saved report could not be read." });
      return;
    }
    setSavedId(report.id);
    setName(report.name);
    const visible = new Set(plants.map((plant) => plant.id));
    const wanted = (loaded.plant_ids ?? []).filter((id) => visible.has(id));
    if (wanted.length > 0) setPlantIds(wanted);
    setDeviceIds(new Set(loaded.series.map((entry) => entry.device_id)));
    setTagCodes(new Set(loaded.series.map((entry) => entry.tag_code)));
    setIntervalMinutes(loaded.interval_minutes);
    setCustomInterval(!INTERVALS.some((option) => option.minutes === loaded.interval_minutes));
    setAggregation(loaded.aggregation ?? "auto");
    setPeriod(loaded.period ?? "today");
    if (loaded.period === "custom") {
      setRange({
        fromDate: loaded.from_date ?? "",
        fromTime: (loaded.from_time ?? "00:00").slice(0, 5),
        toDate: loaded.to_date ?? "",
        toTime: (loaded.to_time ?? "23:59").slice(0, 5),
      });
    }
    if ((loaded.plant_ids ?? []).length > wanted.length) {
      setNotice({
        tone: "info",
        text: "Some of this report's Plants are not visible to you, so their columns are left out.",
      });
    }
  };

  const save = async (asNew: boolean) => {
    if (!definition || !name.trim()) return;
    setSaving(true);
    setNotice(null);
    try {
      const id = await reportsApi.saveReport(
        name.trim(),
        { ...definition, name: name.trim() },
        asNew || savedId === null ? undefined : savedId,
      );
      setSavedId(id);
      await queryClient.invalidateQueries({ queryKey: qk.savedReports() });
      setNotice({ tone: "ok", text: `Saved “${name.trim()}” for everyone in your organisation's account to use.` });
    } catch (error) {
      setNotice({ tone: "bad", text: isApiError(error) ? error.displayMessage : "Could not save the report." });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    if (!window.confirm(`Delete the saved report “${current.name}” for everyone?`)) return;
    setSaving(true);
    try {
      await reportsApi.deleteSavedReport(current.id);
      await queryClient.invalidateQueries({ queryKey: qk.savedReports() });
      setSavedId(null);
      setNotice({ tone: "info", text: `Deleted “${current.name}”. The choices stay on screen.` });
    } catch (error) {
      setNotice({ tone: "bad", text: isApiError(error) ? error.displayMessage : "Could not delete the report." });
    } finally {
      setSaving(false);
    }
  };

  const download = async (format: ReportFormat) => {
    if (!definition || !table || stale) return;
    setExporting(format);
    setNotice(null);
    try {
      const blob = await reportsApi.exportCustomReport(definition, format);
      triggerDownload(blob, reportsApi.reportFilename(table, format));
    } catch (error) {
      if (format === "pdf" && isApiError(error) && error.status === 503) {
        try {
          printHtml(await reportsApi.customReportPage(definition));
          setNotice({
            tone: "info",
            text: "This server has no PDF renderer installed, so the report opened in your browser's print dialog — choose “Save as PDF” as the destination.",
          });
        } catch (inner) {
          setNotice({ tone: "bad", text: isApiError(inner) ? inner.displayMessage : "Could not open the report." });
        }
      } else {
        setNotice({ tone: "bad", text: isApiError(error) ? error.displayMessage : "Could not download the report." });
      }
    } finally {
      setExporting(null);
    }
  };

  // ── Choosing ──────────────────────────────────────────────────────────────
  const togglePlant = (id: number) => {
    setPlantIds((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));
  };
  const toggleDevice = (id: number) => {
    setDeviceIds((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleGroup = (group: DeviceGroup, on: boolean) => {
    setDeviceIds((ids) => {
      const next = new Set(ids);
      for (const device of group.devices) {
        if (on) next.add(device.id);
        else next.delete(device.id);
      }
      return next;
    });
  };
  const toggleReading = (code: string) => {
    setTagCodes((codes) => {
      const next = new Set(codes);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const deviceFilter = deviceSearch.trim().toLowerCase();
  const readingFilter = readingSearch.trim().toLowerCase();
  const shownGroups = groups
    .map((group) => ({
      ...group,
      devices: deviceFilter
        ? group.devices.filter((device) =>
            `${device.code} ${device.name ?? ""} ${group.typeName}`.toLowerCase().includes(deviceFilter),
          )
        : group.devices,
    }))
    .filter((group) => group.devices.length > 0);
  const shownReadings = readingFilter
    ? readings.filter((reading) => `${reading.name} ${reading.code}`.toLowerCase().includes(readingFilter))
    : readings;
  const chosenReadings = readings.filter((reading) => tagCodes.has(reading.code)).length;

  const summary =
    series.length === 0
      ? chosenDevices.length === 0
        ? "Tick the Devices you want, then the readings."
        : "Now tick one or more readings."
      : tooMany
        ? `${series.length} columns — a report holds at most ${MAX_COLUMNS}. Choose fewer Devices or readings.`
        : `${series.length} column${series.length === 1 ? "" : "s"}: ${chosenReadings} reading${
            chosenReadings === 1 ? "" : "s"
          } from ${chosenDevices.length} Device${chosenDevices.length === 1 ? "" : "s"}.`;

  return (
    <>
      <Panel
        title="Custom report"
        subtitle="Choose Plants, Devices and readings, then the period and interval. The preview below updates as you go."
      >
        <div className="space-y-5">
          {/* Saved reports: open one, or start fresh. */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
              <span className="field-label shrink-0">Saved</span>
              <select
                className={`${smallField} min-w-0 flex-1 sm:w-72`}
                value={savedId ?? ""}
                onChange={(event) => {
                  const id = Number(event.target.value);
                  open(saved.find((report) => report.id === id) ?? null);
                }}
                aria-label="Open a saved report"
              >
                <option value="">{saved.length === 0 ? "No saved reports yet" : "New report"}</option>
                {saved.map((report) => (
                  <option key={report.id} value={report.id}>
                    {report.name}
                    {report.created_by_email ? ` — ${report.created_by_email}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {savedId !== null ? (
              <Button variant="ghost" onClick={() => open(null)}>
                Start a new one
              </Button>
            ) : null}
          </div>

          {/* 1. Plants */}
          <div>
            <p className="field-label mb-2">1 · Plants</p>
            {plants.length === 1 ? (
              <p className="text-sm text-ink">{plants[0]?.name}</p>
            ) : (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Plants">
                {plants.map((plant) => {
                  const on = plantIds.includes(plant.id);
                  return (
                    <button
                      key={plant.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => togglePlant(plant.id)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                        on
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-line text-ink-muted hover:border-accent/40 hover:text-ink"
                      }`}
                      title={plant.code}
                    >
                      {plant.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. Devices · 3. Readings */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <p className="field-label">2 · Devices</p>
                <span className="text-xs text-ink-faint">{chosenDevices.length} chosen</span>
              </div>
              <div className={boxClass}>
                <div className="border-b border-line p-2">
                  <input
                    className={searchClass}
                    placeholder="Find a Device…"
                    value={deviceSearch}
                    onChange={(event) => setDeviceSearch(event.target.value)}
                    aria-label="Find a Device"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {plantIds.length === 0 ? (
                    <p className="p-2 text-xs text-ink-faint">Choose at least one Plant.</p>
                  ) : catalogQuery.isLoading ? (
                    <p className="p-2 text-xs text-ink-faint">Loading the Devices…</p>
                  ) : catalogQuery.isError ? (
                    <p className="p-2 text-xs text-bad">The Devices could not be loaded.</p>
                  ) : shownGroups.length === 0 ? (
                    <p className="p-2 text-xs text-ink-faint">
                      {deviceFilter ? "No Device matches." : "No Devices are registered at these Plants."}
                    </p>
                  ) : (
                    shownGroups.map((group) => {
                      const all = group.devices.every((device) => deviceIds.has(device.id));
                      const some = group.devices.some((device) => deviceIds.has(device.id));
                      // Open by default when there are few groups or a search
                      // is narrowing them; the reader's own toggle wins.
                      const byDefault = groups.length <= 3 || deviceFilter !== "";
                      const expanded = byDefault !== flipped.has(group.key);
                      return (
                        <div key={group.key} className="mb-1">
                          <div className="flex items-center gap-2 rounded-control px-1.5 py-1 text-xs hover:bg-surface-raised">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() =>
                                setFlipped((keys) => {
                                  const next = new Set(keys);
                                  if (next.has(group.key)) next.delete(group.key);
                                  else next.add(group.key);
                                  return next;
                                })
                              }
                              className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                            >
                              <IconChevronDown
                                size={13}
                                className={`shrink-0 text-ink-faint transition ${expanded ? "rotate-180" : ""}`}
                              />
                              <span className="min-w-0 flex-1 truncate font-semibold text-ink">
                                {sortedPlantIds.length > 1 ? `${group.plantCode} · ` : ""}
                                {group.typeName}
                                <span className="ml-1 font-normal text-ink-faint">({group.devices.length})</span>
                              </span>
                            </button>
                            <label className="flex shrink-0 items-center gap-1.5 text-ink-muted">
                              <input
                                type="checkbox"
                                checked={all}
                                ref={(node) => {
                                  if (node) node.indeterminate = some && !all;
                                }}
                                onChange={(event) => toggleGroup(group, event.target.checked)}
                                className="accent-[rgb(var(--c-accent))]"
                                aria-label={`All ${group.typeName} at ${group.plantCode}`}
                              />
                              All
                            </label>
                          </div>
                          {expanded ? (
                            <ul className="ml-6 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                              {group.devices.map((device) => (
                                <li key={device.id}>
                                  <label className="flex min-w-0 items-center gap-2 rounded-control px-1 py-1 text-xs hover:bg-surface-raised">
                                    <input
                                      type="checkbox"
                                      checked={deviceIds.has(device.id)}
                                      onChange={() => toggleDevice(device.id)}
                                      className="accent-[rgb(var(--c-accent))]"
                                    />
                                    <span className="truncate font-mono text-ink" title={device.name ?? device.code}>
                                      {device.code}
                                    </span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          ) : some ? (
                            <p className="ml-7 pb-1 text-[11px] text-ink-faint">
                              {group.devices.filter((device) => deviceIds.has(device.id)).length} of{" "}
                              {group.devices.length} chosen
                            </p>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <p className="field-label">3 · Readings</p>
                <span className="text-xs text-ink-faint">{chosenReadings} chosen</span>
              </div>
              <div className={boxClass}>
                <div className="border-b border-line p-2">
                  <input
                    className={searchClass}
                    placeholder="Find a reading — power, energy, voltage…"
                    value={readingSearch}
                    onChange={(event) => setReadingSearch(event.target.value)}
                    aria-label="Find a reading"
                    disabled={readings.length === 0}
                  />
                </div>
                <div className="max-h-72 overflow-y-auto p-2">
                  {readings.length === 0 ? (
                    <p className="p-2 text-xs text-ink-faint">
                      Readings appear here once Devices are ticked — only what they actually send.
                    </p>
                  ) : shownReadings.length === 0 ? (
                    <p className="p-2 text-xs text-ink-faint">No reading matches.</p>
                  ) : (
                    <ul>
                      {shownReadings.map((reading) => (
                        <li key={reading.code}>
                          <label className="flex min-w-0 items-center gap-2 rounded-control px-1 py-1 text-xs hover:bg-surface-raised">
                            <input
                              type="checkbox"
                              checked={tagCodes.has(reading.code)}
                              onChange={() => toggleReading(reading.code)}
                              className="accent-[rgb(var(--c-accent))]"
                            />
                            <span className="min-w-0 flex-1 truncate text-ink" title={reading.code}>
                              {reading.name}
                              {reading.unit && !["code", "bool", "ratio"].includes(reading.unit) ? (
                                <span className="ml-1 text-ink-faint">({reading.unit})</span>
                              ) : null}
                            </span>
                            {reading.count < chosenDevices.length ? (
                              <span className="shrink-0 text-[10px] text-ink-faint">
                                {reading.count} of {chosenDevices.length}
                              </span>
                            ) : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>

          <p className={`text-xs ${tooMany ? "text-bad" : "text-ink-muted"}`} role="status">
            {summary}
          </p>

          {/* 4. When · 5. How often */}
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="min-w-0">
              <p className="field-label mb-2">4 · Period</p>
              <ReportPeriodPicker
                period={period}
                onPeriod={(next) => {
                  setPeriod(next);
                  setNotice(null);
                }}
                range={range}
                onRange={setRange}
                now={now}
                zone={zone}
                problem={rangeProblem}
                noteId="custom-range-note"
              />
            </div>
            <div className="min-w-0">
              <p className="field-label mb-2">5 · One row every</p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="max-w-full overflow-x-auto">
                  <SegmentedControl
                    label="Interval"
                    value={customInterval ? "custom" : String(intervalMinutes)}
                    onChange={(next) => {
                      if (next === "custom") {
                        setCustomInterval(true);
                      } else {
                        setCustomInterval(false);
                        setIntervalMinutes(Number(next));
                      }
                    }}
                    options={[
                      ...INTERVALS.map((option) => ({
                        value: String(option.minutes),
                        label: <span className="whitespace-nowrap">{option.label}</span>,
                      })),
                      { value: "custom", label: <span className="whitespace-nowrap">Other</span> },
                    ]}
                  />
                </div>
                {customInterval ? (
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      step={1}
                      inputMode="numeric"
                      value={intervalMinutes}
                      onChange={(event) =>
                        setIntervalMinutes(Math.max(1, Math.min(10080, Math.round(Number(event.target.value) || 1))))
                      }
                      className={`${smallField} w-20`}
                      aria-label="Interval in minutes"
                    />
                    minutes
                  </label>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                {intervalMinutes % 15 === 0
                  ? "Built from 15-minute data, kept for three years."
                  : "Built from minute-by-minute data, kept for a year."}
              </p>
            </div>
          </div>

          {/* More options, out of the way until wanted. */}
          <details className="group/more">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink">
              <IconChevronDown size={13} className="transition group-open/more:rotate-180" />
              More options
              {aggregation !== "auto" ? (
                <span className="text-ink-faint">
                  · {AGGREGATIONS.find((option) => option.value === aggregation)?.label}
                </span>
              ) : null}
            </summary>
            <div className="mt-3">
              <p className="field-label mb-2">Each interval shows</p>
              <div className="max-w-full overflow-x-auto">
                <SegmentedControl
                  label="Each interval shows"
                  value={aggregation}
                  onChange={setAggregation}
                  options={AGGREGATIONS.map((option) => ({
                    value: option.value,
                    hint: option.hint,
                    label: <span className="whitespace-nowrap">{option.label}</span>,
                  }))}
                />
              </div>
              <p className="mt-2 text-xs text-ink-faint">
                {AGGREGATIONS.find((option) => option.value === aggregation)?.hint}
              </p>
            </div>
          </details>

          {/* Download and save. */}
          <div className="flex flex-col gap-3 border-t border-line pt-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input
                className={`${smallField} min-w-0 flex-1 sm:w-64 sm:flex-none`}
                placeholder="Name, to save it — e.g. Inverter power, hourly"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                aria-label="Report name"
              />
              {current && current.can_change ? (
                <>
                  <Button
                    variant="primary"
                    disabled={saving || !definition || !name.trim()}
                    onClick={() => void save(false)}
                  >
                    Update
                  </Button>
                  <Button disabled={saving || !definition || !name.trim()} onClick={() => void save(true)}>
                    Save as new
                  </Button>
                  <Button variant="danger" disabled={saving} onClick={() => void remove()}>
                    Delete
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  disabled={saving || !definition || !name.trim()}
                  onClick={() => void save(true)}
                  title={
                    current && !current.can_change
                      ? "Saved by someone else; this saves your version as a new report."
                      : "Saved for everyone in your organisation's account."
                  }
                >
                  {current ? "Save as new" : "Save"}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2 lg:shrink-0">
              {FORMATS.map(({ format, label, hint }) => (
                <Button
                  key={format}
                  onClick={() => void download(format)}
                  disabled={!table || stale || exporting !== null || !definition}
                  title={hint}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm"
                >
                  <IconExport size={15} />
                  {exporting === format ? "Preparing…" : label}
                </Button>
              ))}
            </div>
          </div>

          {notice ? (
            <p
              role={notice.tone === "bad" ? "alert" : "status"}
              className={`rounded-control border px-3 py-2 text-xs ${
                notice.tone === "bad"
                  ? "border-bad/30 bg-bad/10 text-bad"
                  : "border-line bg-surface-sunken text-ink-muted"
              }`}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      </Panel>

      <ReportPreview
        table={table}
        loading={settled !== null && tableQuery.isLoading}
        fetching={tableQuery.isFetching}
        stale={stale && table !== undefined}
        error={settled !== null && tableQuery.isError ? tableQuery.error : null}
        retry={() => void tableQuery.refetch()}
        waitingForRange={definition === null}
        waitingHint={rangeProblem ?? summary}
        emptyHint="Choose Devices and readings to see the report."
      />
    </>
  );
}
