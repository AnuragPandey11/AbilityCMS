/**
 * Which comparisons the power trend can offer on this Plant, and the series
 * for the ones chosen.
 *
 * Every option is always listed. One this Plant cannot answer — no weather
 * station, no DC capacity to lock the axes to, a unit the reference is not
 * defined for — stays in the menu disabled, with the reason: an option that
 * silently vanishes on some Plants reads as a feature that does not exist.
 *
 * Memoised on its inputs, and that is load-bearing: the chart re-applies its
 * option whenever its series change, and a fresh array on every render would
 * reset the reader's zoom each time a live frame arrived.
 */

import { useMemo } from "react";
import type { ResolvedSlot } from "@/api/schemas";
import type { SlotTrend } from "@/api/useSlotTrend";
import type { ComparisonSeries, SeriesLine } from "./PowerComparisonChart";
import {
  IRRADIANCE_UNIT,
  POWER_UNIT,
  expectedAcKw,
  expectedDcKw,
  kwPerWm2,
  medianGeneratingEfficiency,
} from "./powerComparison";
import { formatNumber } from "@/format/value";

export type CompareKey = "radiation" | "exp_ac" | "exp_dc";

/** Direct radiation on by default: the client's reference chart draws it. */
export const COMPARE_DEFAULT: readonly CompareKey[] = ["radiation"];

/** Palette slot per series, fixed so a curve keeps its colour when others toggle. */
export const COMPARE_SLOT: Record<"power" | CompareKey, number> = {
  power: 0,
  radiation: 1,
  exp_dc: 2,
  exp_ac: 3,
};

export interface CompareOption {
  value: CompareKey;
  label: string;
  description: string;
  disabledReason: string | null;
  line: SeriesLine;
}

export function usePowerComparison({
  power,
  radiation,
  irradiance,
  efficiency,
  environment,
  dcCapacityKwp,
  acCapacityKw,
  chosen,
}: {
  power: SlotTrend;
  /** `env.direct_radiation`. */
  radiation: SlotTrend;
  /** `env.irradiance` — plane-of-array first, which the references are computed from. */
  irradiance: SlotTrend;
  /** `sld.inv.efficiency` — the Inverters' own efficiency, in %, for the AC reference. */
  efficiency: SlotTrend;
  /** The `environment` panel, to tell "no weather station" from "not loaded". */
  environment: ResolvedSlot[] | undefined;
  dcCapacityKwp: number | null | undefined;
  acCapacityKw: number | null | undefined;
  chosen: ReadonlySet<CompareKey>;
}): {
  series: ComparisonSeries[];
  options: CompareOption[];
  perWm2: number | null;
  flaggedCount: number;
  isLoading: boolean;
} {
  return useMemo(() => {
    const perWm2 = kwPerWm2(dcCapacityKwp);
    const slots = environment ?? [];
    const radiationSlot = slots.find((slot) => slot.slot_code === "env.direct_radiation");
    const irradianceSlot = slots.find((slot) => slot.slot_code === "env.irradiance");
    const irradianceTag = irradianceSlot?.source?.tag_code ?? "irradiance";

    const noLock =
      "No DC capacity is recorded for this Plant, so there is nothing to tie a W/m² scale " +
      "to kW. Record it in Plants & Devices.";
    const wrongPowerUnit =
      power.unit === POWER_UNIT
        ? null
        : `Current Power is reported in ${power.unit ?? "no unit"}, and this is defined in ` +
          `${POWER_UNIT} — not compared rather than risk a factor-of-1000 error.`;

    const radiationReason = !radiationSlot
      ? "No weather station at this Plant reports direct radiation."
      : (radiation.unavailableReason ??
        (perWm2 === null
          ? noLock
          : radiation.unit !== IRRADIANCE_UNIT
            ? `Direct radiation is reported in ${radiation.unit ?? "no unit"}, not ${IRRADIANCE_UNIT}.`
            : wrongPowerUnit));

    const irradianceReason = !irradianceSlot
      ? "No weather station at this Plant reports the irradiance this is computed from."
      : (irradiance.unavailableReason ??
        (irradiance.unit !== IRRADIANCE_UNIT
          ? `Irradiance is reported in ${irradiance.unit ?? "no unit"}, not ${IRRADIANCE_UNIT}.`
          : null));
    const expDcReason = irradianceReason ?? (perWm2 === null ? noLock : wrongPowerUnit);
    // The Inverters' measured conversion efficiency — what makes the AC
    // reference sit below the DC one, as it does on every real Plant.
    const eta = efficiency.unit === "%" ? medianGeneratingEfficiency(efficiency.points) : null;
    const expAcReason =
      expDcReason ??
      (acCapacityKw === null || acCapacityKw === undefined || !(acCapacityKw > 0)
        ? "No AC capacity is recorded for this Plant, so there is no Inverter limit to apply."
        : efficiency.unavailableReason
          ? "No Inverter here reports its efficiency, so there is no measured conversion loss to apply."
          : efficiency.unit !== "%"
            ? `Inverter efficiency is reported in ${efficiency.unit ?? "no unit"}, not %.`
            : eta === null
              ? efficiency.isLoading
                ? "Loading the Inverters' efficiency…"
                : "No Inverter reported an efficiency while generating in this window."
              : null);

    // Horizontal irradiance is what answers where there is no plane-of-array
    // sensor; it reads low on a tilted array, and the description says so.
    const basis =
      irradianceTag === "GHI"
        ? "GHI (horizontal — reads low on a tilted array)"
        : irradianceTag;
    const dcText = dcCapacityKwp ? `${formatNumber(dcCapacityKwp, { digits: 0 })} kWp` : "the DC nameplate";
    const acText = acCapacityKw ? `${formatNumber(acCapacityKw, { digits: 0 })} kW` : "the AC nameplate";

    const options: CompareOption[] = [
      {
        value: "radiation",
        label: "Direct radiation",
        description: "From the weather station, on the right-hand axis, locked to the DC nameplate.",
        disabledReason: radiationReason,
        line: "solid",
      },
      {
        value: "exp_ac",
        label: "Exp Power (AC)",
        description:
          `Exp Power (DC) × the Inverters' measured efficiency` +
          (eta !== null ? ` (${formatNumber(eta * 100, { digits: 1 })}%, their median while generating)` : "") +
          `, limited to ${acText}. A ceiling, not a forecast.`,
        disabledReason: expAcReason,
        line: "dotted",
      },
      {
        value: "exp_dc",
        label: "Exp Power (DC)",
        description: `${basis} × ${dcText} ÷ 1,000 W/m². Lossless and not temperature-corrected — a ceiling, not a forecast.`,
        disabledReason: expDcReason,
        line: "dashed",
      },
    ];

    const on = (key: CompareKey) =>
      chosen.has(key) && !options.find((option) => option.value === key)?.disabledReason;

    const series: ComparisonSeries[] = [
      {
        key: "power",
        label: "Actual power",
        unit: power.unit,
        points: power.points,
        axis: "power",
        line: "solid",
        slot: COMPARE_SLOT.power,
        fill: true,
        note: power.provenance ?? undefined,
      },
    ];
    if (on("radiation")) {
      series.push({
        key: "radiation",
        label: "Direct radiation",
        unit: radiation.unit,
        points: radiation.points,
        axis: "radiation",
        line: "solid",
        slot: COMPARE_SLOT.radiation,
        fill: true,
        note: `${radiation.provenance ?? "WMS"} · DIRECT_RADIATION`,
      });
    }
    const dcReference =
      (on("exp_dc") || on("exp_ac")) && dcCapacityKwp ? expectedDcKw(irradiance.points, dcCapacityKwp) : [];
    if (on("exp_dc")) {
      series.push({
        key: "exp_dc",
        label: "Exp Power (DC)",
        unit: POWER_UNIT,
        points: dcReference,
        axis: "power",
        line: "dashed",
        slot: COMPARE_SLOT.exp_dc,
        fill: false,
        note: options[2]?.description,
      });
    }
    if (on("exp_ac") && acCapacityKw && eta !== null) {
      series.push({
        key: "exp_ac",
        label: "Exp Power (AC)",
        unit: POWER_UNIT,
        points: expectedAcKw(dcReference, acCapacityKw, eta),
        axis: "power",
        line: "dotted",
        slot: COMPARE_SLOT.exp_ac,
        fill: false,
        note: options[1]?.description,
      });
    }

    const usesIrradiance = on("exp_dc") || on("exp_ac");
    const usesEfficiency = on("exp_ac");
    return {
      series,
      options,
      perWm2,
      flaggedCount:
        power.flaggedCount +
        (on("radiation") ? radiation.flaggedCount : 0) +
        (usesIrradiance ? irradiance.flaggedCount : 0),
      isLoading:
        power.isLoading ||
        (on("radiation") && radiation.isLoading) ||
        (usesIrradiance && irradiance.isLoading) ||
        (usesEfficiency && efficiency.isLoading),
    };
    // Deliberately the parts, not the objects: `useSlotTrend` returns a fresh
    // object every render, and depending on it would rebuild every series each
    // time — see the module note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    power.points, power.unit, power.provenance, power.flaggedCount, power.isLoading,
    radiation.points, radiation.unit, radiation.provenance, radiation.unavailableReason,
    radiation.flaggedCount, radiation.isLoading,
    irradiance.points, irradiance.unit, irradiance.unavailableReason, irradiance.flaggedCount,
    irradiance.isLoading,
    efficiency.points, efficiency.unit, efficiency.unavailableReason, efficiency.isLoading,
    environment, dcCapacityKwp, acCapacityKw, chosen,
  ]);
}
