/**
 * The Plant's forecast: a one-line peek inside the Current Power card, and the
 * whole of it in a drawer — next 15 minutes and hour, the rest of today,
 * tomorrow, the week ahead, and how the method has done against what happened.
 *
 * ⚠ From the Plant's own history only, with no weather forecast (the user's
 * choice, 8 Oct 2026): it cannot foresee a cloudy tomorrow, and every part of
 * it says so where it matters. `services/forecast.py` has the method.
 *
 * Never in the way: the peek renders at once with whatever is known, the
 * request is cached for a minute on both sides, and a Plant without enough
 * history is told so rather than shown a guess (Guardrail 26). Forecasts are
 * never drawn as measurements — dashed, and labelled "forecast" everywhere.
 */

import type { PlantForecast } from "@/api/endpoints/forecast";
import { Panel } from "@/components/ui";
import { IconChevronRight } from "@/components/icons";
import { dayInZone, formatTime } from "@/format/datetime";
import { UNDEFINED_DISPLAY, formatHeadline, formatNumber } from "@/format/value";
import { ForecastChart } from "./ForecastChart";

const ACTUAL_SLOT = 0;
const FORECAST_SLOT = 1;

function figure(value: number | null | undefined, unit: string | null): string {
  if (value === null || value === undefined) return UNDEFINED_DISPLAY;
  const text = formatHeadline(value).text;
  return unit ? `${text} ${unit}` : text;
}

function dayLabel(iso: string): string {
  // A calendar date, not an instant: read at noon UTC so no zone moves it.
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T12:00:00Z`));
}

function percent(share: number | null | undefined): string | null {
  return share === null || share === undefined ? null : `${formatNumber(share * 100, { digits: 0 })}%`;
}

// ── The peek ────────────────────────────────────────────────────────────────

/**
 * The next fifteen minutes, at the foot of the Current Power card. Same height
 * in every state, so the card never jumps when the forecast arrives.
 */
export function ForecastPeek({
  forecast,
  isLoading,
  isError,
  onOpen,
}: {
  forecast: PlantForecast | undefined;
  isLoading: boolean;
  isError: boolean;
  onOpen: () => void;
}): JSX.Element {
  const power = forecast?.power ?? null;
  const next = power?.next_15m ?? null;
  let label = "Next 15 min";
  let value: string;
  let faint = false;
  let title: string;
  if (isLoading) {
    value = "…";
    faint = true;
    title = "Working out the forecast.";
  } else if (isError || !forecast) {
    label = "Forecast";
    value = "unavailable";
    faint = true;
    title = "The forecast could not be loaded. The figure above is unaffected.";
  } else if (!power || power.unavailable) {
    label = "Forecast";
    value = "needs more history";
    faint = true;
    title = power?.unavailable ?? forecast.power_unavailable ?? "Nothing here answers Current Power.";
  } else if (next?.value === null || next?.value === undefined) {
    value = UNDEFINED_DISPLAY;
    faint = true;
    title =
      "Not enough history at this time of day to forecast from yet — the Plant's recent days " +
      "have holes here. Open for the rest of the forecast.";
  } else {
    value = `≈ ${figure(next.value, power.unit)}`;
    title =
      `Forecast for ${formatTime(next.at, forecast.timezone).slice(0, 5)}, from this Plant's own ` +
      "last 14 days — no weather forecast. Open for the next hour, tomorrow and the week.";
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
    >
      <span className="shrink-0">{label}</span>
      <span className={`flex min-w-0 items-center gap-1 ${faint ? "text-ink-faint" : "figure font-semibold text-ink"}`}>
        <span className="truncate">{value}</span>
        <IconChevronRight size={12} className="shrink-0 text-ink-muted" />
      </span>
    </button>
  );
}

// ── The drawer ──────────────────────────────────────────────────────────────

function Figure({
  label,
  value,
  note,
  forecast = false,
}: {
  label: string;
  value: string;
  note?: string;
  forecast?: boolean;
}): JSX.Element {
  return (
    <div className="surface-tile min-w-0 rounded-card border border-line px-3.5 py-2.5">
      <div className="truncate text-xs font-medium text-ink-muted">{label}</div>
      <div className={`figure mt-1 truncate text-xl font-semibold ${forecast ? "text-chart" : "text-ink"}`}>
        {value}
      </div>
      {note ? <div className="mt-0.5 truncate text-[11px] text-ink-faint">{note}</div> : null}
    </div>
  );
}

function Unavailable({ children }: { children: string }): JSX.Element {
  return <p className="text-sm leading-snug text-ink-muted">{children}</p>;
}

export function ForecastPanel({
  forecast,
  isLoading,
  isError,
}: {
  forecast: PlantForecast | undefined;
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isLoading) {
    return <p className="text-sm text-ink-muted">Working out the forecast…</p>;
  }
  if (isError || !forecast) {
    return <Unavailable>The forecast could not be loaded. Try again in a minute.</Unavailable>;
  }
  const tz = forecast.timezone;
  const power = forecast.power && !forecast.power.unavailable ? forecast.power : null;
  const energy = forecast.energy && !forecast.energy.unavailable ? forecast.energy : null;
  const powerReason =
    forecast.power?.unavailable ?? forecast.power_unavailable ?? "Nothing here answers Current Power.";
  const energyReason =
    forecast.energy?.unavailable ?? forecast.energy_unavailable ?? "Nothing here answers today's energy.";
  const unit = power?.unit ?? null;
  const today = dayInZone(Date.parse(forecast.generated_at), tz);
  const tomorrow = dayInZone(today.end + 3_600_000, tz);
  const accuracy15 = power?.accuracy?.find((entry) => entry.horizon_minutes === 15);
  const accuracy60 = power?.accuracy?.find((entry) => entry.horizon_minutes === 60);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-snug text-ink-muted">
        {forecast.method} It cannot foresee a cloudy day. What the measured sunlight should give right
        now is on the power trend (Select options → Exp Power).
      </p>

      <Panel title="Next hours" subtitle={power ? `The same figure as Current Power — ${sourceText(power.source)}` : undefined}>
        {power ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Figure
                label="Last measured"
                value={figure(power.now?.value, unit)}
                note={power.now ? `${formatTime(power.now.at, tz).slice(0, 5)}, the latest complete quarter-hour` : undefined}
              />
              <Figure
                label="Next 15 min"
                value={figure(power.next_15m?.value, unit)}
                note={power.next_15m ? `forecast for ${formatTime(power.next_15m.at, tz).slice(0, 5)}` : undefined}
                forecast
              />
              <Figure
                label="Next hour"
                value={figure(power.next_1h?.value, unit)}
                note={power.next_1h ? `forecast for ${formatTime(power.next_1h.at, tz).slice(0, 5)}` : undefined}
                forecast
              />
            </div>
            {power.next_15m?.value === null || power.next_15m?.value === undefined ? (
              <p className="text-xs text-ink-faint">
                Not enough history at this time of day to forecast from yet: the Plant&apos;s recent days
                have holes here. It fills in as complete days accumulate.
              </p>
            ) : null}
            <ForecastChart
              lines={[
                {
                  key: "actual",
                  label: "Measured",
                  points: (power.today ?? []).map((row) => ({ at: row.at, value: row.actual })),
                  slot: ACTUAL_SLOT,
                  line: "solid",
                },
                {
                  key: "forecast",
                  label: "Forecast",
                  points: (power.today ?? []).map((row) => ({ at: row.at, value: row.forecast })),
                  slot: FORECAST_SLOT,
                  line: "dashed",
                },
              ]}
              band={(power.today ?? []).map((row) => ({ at: row.at, low: row.low, high: row.high }))}
              bandLabel="Usual range, last 14 days"
              unit={unit}
              timezone={tz}
              day={today}
            />
          </div>
        ) : (
          <Unavailable>{powerReason}</Unavailable>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tomorrow" subtitle={energy ? `The same figure as Today's Energy — ${sourceText(energy.source)}` : undefined}>
          {energy?.tomorrow ? (
            <div className="space-y-3">
              <Figure
                label={dayLabel(energy.tomorrow.date)}
                value={figure(energy.tomorrow.value, energy.unit)}
                note={`usually ${figure(energy.tomorrow.low, energy.unit)} – ${figure(energy.tomorrow.high, energy.unit)}, from ${energy.history_days ?? 0} complete days`}
                forecast
              />
              {power?.day_ahead ? (
                <ForecastChart
                  lines={[
                    {
                      key: "forecast",
                      label: "Forecast power",
                      points: power.day_ahead.profile.map((row) => ({ at: row.at, value: row.forecast })),
                      slot: FORECAST_SLOT,
                      line: "dashed",
                    },
                  ]}
                  band={power.day_ahead.profile.map((row) => ({ at: row.at, low: row.low, high: row.high }))}
                  unit={unit}
                  timezone={tz}
                  day={tomorrow}
                  height={180}
                />
              ) : null}
            </div>
          ) : (
            <Unavailable>{energyReason}</Unavailable>
          )}
        </Panel>

        <Panel
          title="Next 7 days"
          subtitle={energy ? "Each day is the Plant's typical day — history cannot tell one day's weather from another's." : undefined}
        >
          {energy?.week ? (
            <ul className="divide-y divide-line-soft">
              {energy.week.map((day) => (
                <li key={day.date} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                  <span className="text-ink-muted">{dayLabel(day.date)}</span>
                  <span className="text-right">
                    <span className="figure font-semibold text-chart">{figure(day.value, energy.unit)}</span>
                    <span className="ml-2 text-[11px] text-ink-faint">
                      {figure(day.low, null)}–{figure(day.high, null)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Unavailable>{energyReason}</Unavailable>
          )}
        </Panel>
      </div>

      <Panel
        title="Forecast vs actual"
        subtitle="What this method would have said on recent days, using only what was known before each one."
      >
        <div className="space-y-4">
          {power ? (
            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Figure
                  label="15 minutes ahead, typically off by"
                  value={figure(accuracy15?.mae, unit)}
                  note={
                    accuracy15?.samples
                      ? `${percent(accuracy15.relative) ?? "—"} of the output then · ${accuracy15.samples} daylight quarter-hours`
                      : "not enough complete days to check yet"
                  }
                />
                <Figure
                  label="1 hour ahead, typically off by"
                  value={figure(accuracy60?.mae, unit)}
                  note={
                    accuracy60?.samples
                      ? `${percent(accuracy60.relative) ?? "—"} of the output then · ${accuracy60.samples} daylight quarter-hours`
                      : "not enough complete days to check yet"
                  }
                />
              </div>
              {(power.versus_actual ?? []).length > 0 ? (
                <ForecastChart
                  lines={[
                    {
                      key: "actual",
                      label: "Measured",
                      points: (power.versus_actual ?? []).map((row) => ({ at: row.at, value: row.actual })),
                      slot: ACTUAL_SLOT,
                      line: "solid",
                    },
                    {
                      key: "forecast",
                      label: "Forecast 15 min ahead",
                      points: (power.versus_actual ?? []).map((row) => ({ at: row.at, value: row.forecast })),
                      slot: FORECAST_SLOT,
                      line: "dashed",
                    },
                  ]}
                  unit={unit}
                  timezone={tz}
                  height={180}
                />
              ) : null}
            </div>
          ) : null}
          {energy ? (
            (energy.versus_actual ?? []).length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[22rem] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
                      <th className="py-1 font-medium">Day</th>
                      <th className="py-1 text-right font-medium">Forecast</th>
                      <th className="py-1 text-right font-medium">Actual</th>
                      <th className="py-1 text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {(energy.versus_actual ?? []).map((row) => (
                      <tr key={row.date}>
                        <td className="py-1.5 text-ink-muted">{dayLabel(row.date)}</td>
                        <td className="figure py-1.5 text-right text-chart">{figure(row.forecast, null)}</td>
                        <td className="figure py-1.5 text-right text-ink">{figure(row.actual, null)}</td>
                        <td className="figure py-1.5 text-right text-ink-muted">
                          {row.forecast !== null && row.actual !== null
                            ? `${row.actual - row.forecast >= 0 ? "+" : ""}${formatNumber(row.actual - row.forecast, { digits: 0 })}`
                            : UNDEFINED_DISPLAY}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1.5 text-xs text-ink-faint">
                  {energy.unit ?? ""} per day.
                  {energy.accuracy?.mae !== null && energy.accuracy?.mae !== undefined
                    ? ` Typically off by ${figure(energy.accuracy.mae, energy.unit)}${
                        percent(energy.accuracy.relative) ? ` (${percent(energy.accuracy.relative)})` : ""
                      } over ${energy.accuracy.samples} days.`
                    : ""}
                </p>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                Daily energy can be checked once there are complete days before the ones being
                forecast.
              </p>
            )
          ) : null}
          {!power && !energy ? <Unavailable>{powerReason}</Unavailable> : null}
        </div>
      </Panel>
    </div>
  );
}

function sourceText(source: { device_type_code: string | null; tag_code: string | null; aggregate: string | null; device_count: number | null }): string {
  const who =
    source.aggregate === "sum" && (source.device_count ?? 0) > 1
      ? `sum of ${source.device_count} ${source.device_type_code ?? "Devices"}`
      : (source.device_type_code ?? "its source");
  return `${who}${source.tag_code ? ` · ${source.tag_code}` : ""}`;
}
