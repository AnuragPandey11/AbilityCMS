/**
 * Energy Summary — the day's energy figures, as one list.
 *
 * The client's reference card, row for row. Two sources, and each row says
 * which on its tooltip:
 *
 * - **Generated today, current power, lifetime** — the headline slots, so each
 *   is the same claim, from the same Device, as the tiles elsewhere on the page.
 * - **Specific yield, PR, CO₂** — `GET /plants/{id}/kpis?period=today`, always
 *   today whatever the Period control says, because the card is about today.
 *   When the Period *is* today this is the same request the gauges made, so
 *   the PR here and the PR on the gauge cannot disagree.
 *
 * ⚠ Those three are computed from the energy the Plant's **meter counter**
 * advanced today (`energy_source`), which is not necessarily the Inverters'
 * "generated today" register in the first row — generated and exported are
 * different quantities. The tooltip names the basis rather than letting the
 * two be read as one number.
 *
 * ⚠ Units are never rescaled. The reference prints "1.71 MWh"; a kWh figure is
 * compacted as a numeral (`1.49M kWh`) and never converted, because rescaling
 * against a unit the backend did not state is the factor-of-1000 error §4.1
 * exists to prevent. CO₂ stays in the kilograms the API states.
 */

import type { KpiFigure, PlantKpis, ResolvedSlot } from "@/api/schemas";
import { sourceLabel, undefinedExplanation } from "@/components/dashboard/SlotValue";
import { Panel } from "@/components/ui";
import {
  UNDEFINED_DISPLAY,
  digitsForUnit,
  formatHeadline,
  formatNumber,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import { StatusRow, cardHeading, type StatusRowData } from "./PlantStatusCard";

function slotRow(label: string, slot: ResolvedSlot | undefined): StatusRowData {
  if (!slot) {
    return {
      label,
      value: UNDEFINED_DISPLAY,
      tone: "faint",
      title: "No Device at this Plant is bound to a Tag that could answer this.",
    };
  }
  if (slot.value === null) {
    return { label, value: UNDEFINED_DISPLAY, tone: "faint", title: undefinedExplanation(slot) };
  }
  const headline = formatHeadline(slot.value, { digits: digitsForUnit(slot.unit) });
  const source = sourceLabel(slot.source);
  return {
    label,
    value: (
      <>
        {headline.text}
        {slot.unit ? <span className="ml-1 text-xs text-ink-muted">{slot.unit}</span> : null}
      </>
    ),
    tone: "ink",
    title: [
      headline.compacted ? `${headline.exact}${slot.unit ? ` ${slot.unit}` : ""}` : null,
      source ? `${source}${slot.source?.tag_code ? ` · ${slot.source.tag_code}` : ""}` : null,
      slot.source?.degraded ? "fallback source" : null,
    ]
      .filter(Boolean)
      .join(" — "),
  };
}

/** What today's derived figures were computed from, for their tooltips. */
function energyBasis(kpis: PlantKpis): string {
  const source = kpis.energy_source;
  const from = source?.device_type_code
    ? ` from the ${source.device_type_code}${source.tag_code ? ` ${source.tag_code}` : ""} counter`
    : "";
  return `Today's ${formatNumber(kpis.energy_kwh)} kWh${from}.`;
}

function kpiRow(
  label: string,
  figure: KpiFigure | null | undefined,
  kind: "ratio" | "quantity",
  unit: string | null,
  kpis: PlantKpis | undefined,
  digits?: number,
): StatusRowData {
  if (!kpis) return { label, value: UNDEFINED_DISPLAY, tone: "faint", pending: true };
  const value = figure?.value ?? null;
  if (value === null) {
    return {
      label,
      value: UNDEFINED_DISPLAY,
      tone: "faint",
      title: figure?.undefined_reason ?? "Not defined for today.",
    };
  }
  const basis = energyBasis(kpis);
  const variant = figure?.variant ? ` ${variantNote(figure.variant)}` : "";
  if (kind === "ratio") {
    // Outside the range the quantity can take: shown unaltered and flagged,
    // never clamped into something that looks like a result (Guardrail 33).
    const implausible = ratioIsImplausible(value);
    return {
      label,
      value: formatRatioAsPercent(value),
      tone: implausible ? "warn" : "ink",
      title: implausible ? implausibleRatioReason(value, label) : `${basis}${variant}`,
    };
  }
  const headline = formatHeadline(value, { digits });
  return {
    label,
    value: (
      <>
        {headline.text}
        {unit ? <span className="ml-1 text-xs text-ink-muted">{unit}</span> : null}
      </>
    ),
    tone: "ink",
    title: `${basis}${variant}`,
  };
}

export function EnergySummaryCard({
  headline,
  today,
  onOpen,
  className = "",
}: {
  /** The `kpi_row` panel's slots, as the server resolved them. */
  headline: ResolvedSlot[];
  /** `/kpis?period=today` — never the page's Period. */
  today: PlantKpis | undefined;
  onOpen: () => void;
  className?: string;
}): JSX.Element {
  const bySlot = new Map(headline.map((slot) => [slot.slot_code, slot]));
  const rows: StatusRowData[] = [
    slotRow("Energy Generated Today", bySlot.get("kpi.energy_today")),
    slotRow("Current Plant Power", bySlot.get("kpi.current_power")),
    slotRow("Total Energy (Lifetime)", bySlot.get("kpi.energy_lifetime")),
    kpiRow("Specific Yield (Today)", today?.specific_yield, "quantity", "kWh/kWp", today, 3),
    kpiRow("Performance Ratio (Today)", today?.performance_ratio, "ratio", null, today),
    kpiRow("CO₂ Saved Today", today?.co2_avoided_kg, "quantity", "kg", today),
  ];

  return (
    <Panel
      fill
      padding="px-4 pb-4 pt-1"
      className={className}
      {...cardHeading({ title: "Energy Summary", onOpen, openLabel: "Everything behind Energy Summary" })}
    >
      <div className="flex h-full flex-col">
        <div>
          {rows.map((row) => (
            <StatusRow key={row.label} row={row} />
          ))}
        </div>
        <p className="mt-auto pt-4 text-xs leading-snug text-ink-faint">
          Today since midnight at the Plant. Yield, PR and CO₂ are provisional pending OPEN-16.
        </p>
      </div>
    </Panel>
  );
}
