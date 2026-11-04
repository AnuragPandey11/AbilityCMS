/**
 * One Plant day opened from the calendar: its figures, its power curve under
 * the sunlight, and what happened during it.
 *
 * The curve is the dashboard's own claim: `kpi.current_power` through its slot
 * (`useSlotSeries`), so it is the meter on one Plant and the Inverters' sum on
 * another, exactly as the Single Plant screen draws it, with the provenance
 * printed. The sunlight is the Weather Stations' GHI, averaged across them, in
 * a chart of its own — two measures, two charts (Guardrail 22) — and the
 * day's Alarms and planned work are marked on the power curve's time axis.
 *
 * It names its fuller home (Guardrail 25): the same day on Energy Analytics,
 * where it can be zoomed to the minute.
 */

import { useMemo } from "react";
import type { HistoryDay } from "@/api/endpoints/history";
import { daysPeriod, resolvePeriod } from "@/api/historyPeriod";
import { usePlantDevices, useTags } from "@/api/hooks";
import { useSeries, useSlotSeries } from "@/api/useSeries";
import { useTimelineEvents } from "@/api/useHistory";
import { TrendChart } from "@/components/charts/TrendChart";
import { exportStem } from "@/components/charts/csv";
import { NOT_A_UNIT } from "@/components/devices/InverterView";
import { formatDateTime } from "@/format/datetime";
import { formatNumber } from "@/format/value";
import { METRICS, displayDate, isFlagged, isPartial, valueOf, PARTIAL_COVERAGE } from "./metrics";

const unitOf = (unit: string | null | undefined): string | null => (unit && !NOT_A_UNIT.has(unit) ? unit : null);

export function DayDetail({
  plantId,
  plantCode,
  day,
  timezone,
  nowMs,
  canReadMaintenance,
  canExport,
}: {
  plantId: number;
  plantCode: string | null;
  day: HistoryDay;
  timezone: string;
  nowMs: number;
  canReadMaintenance: boolean;
  canExport: boolean;
}): JSX.Element {
  const range = useMemo(() => {
    const resolved = resolvePeriod(daysPeriod(day.date, day.date), nowMs, timezone);
    return "error" in resolved ? null : resolved;
  }, [day.date, nowMs, timezone]);
  const live = range?.live ?? false;

  const power = useSlotSeries(plantId, "kpi.current_power", range, { live });
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();
  const stations = useMemo(
    () => (devicesQuery.data ?? []).filter((device) => device.type_code === "WMS"),
    [devicesQuery.data],
  );
  const ghiTag = tagsQuery.data?.find((tag) => tag.code === "GHI");
  const ghi = useSeries({ devices: stations, tag: ghiTag, aggregate: "avg" }, range, { live });
  const { events, capped } = useTimelineEvents(plantId, range, { canReadMaintenance, live });
  const moments = events.filter((event) => event.end === undefined || event.end === null).sort((a, b) => a.at - b.at);
  const stretches = events.filter((event) => event.end !== undefined && event.end !== null);

  const stem = (what: string) => (canExport ? exportStem(plantCode, what, day.date) : null);

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {METRICS.map((metric) => {
          const value = valueOf(day, metric.key);
          const flagged = isFlagged(day, metric.key);
          return (
            <div key={metric.key} className="rounded-control border border-line bg-surface-raised p-3">
              <dt className="tile-label">{metric.label}</dt>
              <dd
                className={`figure mt-1 text-lg font-semibold ${value === null ? "text-ink-faint" : flagged ? "text-warn" : "text-ink"}`}
                title={metric.hint}
              >
                {formatNumber(value, { digits: metric.digits })}
                {value !== null ? <span className="ml-1 text-xs font-normal text-ink-muted">{metric.unit}</span> : null}
              </dd>
              {flagged ? (
                <p className="mt-1 text-[11px] leading-snug text-warn">
                  Outside what PR can physically be: the energy and the sunlight cover different spans that day.
                </p>
              ) : null}
            </div>
          );
        })}
      </dl>
      {day.in_progress ? (
        <p className="text-xs text-ink-muted">Today is still running: every figure is so far.</p>
      ) : isPartial(day) ? (
        <p className="text-xs text-warn">
          Under {PARTIAL_COVERAGE}% of this day was measured, so its figures are low by an amount nothing on
          record can state. They are never corrected for it.
        </p>
      ) : null}

      <section>
        <h3 className="field-label mb-1">
          Plant power{unitOf(power.unit) ? ` (${unitOf(power.unit)})` : ""}
        </h3>
        {power.unavailableReason ? (
          <p className="py-6 text-center text-xs text-ink-faint">{power.unavailableReason}</p>
        ) : (
          <TrendChart
            points={power.points}
            unit={unitOf(power.unit)}
            label="Plant power"
            tier={power.tier}
            provenance={power.provenance}
            flaggedCount={power.flaggedCount}
            isLoading={power.isLoading}
            timezone={timezone}
            height={220}
            day={range?.day ?? null}
            events={events}
            exportName={stem("power")}
          />
        )}
      </section>

      <section>
        <h3 className="field-label mb-1">
          Irradiance GHI{unitOf(ghiTag?.unit) ? ` (${unitOf(ghiTag?.unit)})` : ""}
        </h3>
        {stations.length === 0 && !devicesQuery.isLoading ? (
          <p className="py-6 text-center text-xs text-ink-faint">No Weather Station (WMS) is registered at this Plant.</p>
        ) : !ghiTag && !tagsQuery.isLoading ? (
          <p className="py-6 text-center text-xs text-ink-faint">Tag GHI is not in the catalogue.</p>
        ) : (
          <TrendChart
            points={ghi.points}
            unit={unitOf(ghiTag?.unit)}
            label="GHI"
            tier={ghi.tier}
            provenance={stations.length > 1 ? `avg of ${stations.length} WMS` : "WMS"}
            flaggedCount={ghi.flaggedCount}
            isLoading={ghi.isLoading}
            timezone={timezone}
            height={180}
            day={range?.day ?? null}
            markPeak={false}
            exportName={stem("ghi")}
          />
        )}
      </section>

      <section>
        <h3 className="field-label mb-1.5">What happened</h3>
        {moments.length === 0 && stretches.length === 0 ? (
          <p className="text-xs text-ink-faint">No Alarm opened at this Plant on {displayDate(day.date)}.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-soft rounded-control border border-line">
            {[...stretches, ...moments].map((event) => (
              <li key={event.key} className="flex items-baseline gap-3 px-3 py-2 text-xs">
                <span className="figure shrink-0 text-ink-muted">{formatDateTime(event.at, timezone).slice(11, 16)}</span>
                <span
                  className={
                    event.tone === "bad" ? "text-bad" : event.tone === "warn" ? "text-warn" : "text-ink"
                  }
                >
                  {event.label}
                </span>
              </li>
            ))}
          </ul>
        )}
        {capped ? (
          <p className="mt-1 text-[11px] text-ink-faint">
            Only the latest 500 Alarms are listed; the Alarms screen has the rest.
          </p>
        ) : null}
      </section>
    </div>
  );
}
