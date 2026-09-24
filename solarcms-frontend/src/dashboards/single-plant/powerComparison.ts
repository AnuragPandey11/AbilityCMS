/**
 * The arithmetic behind the power trend's comparisons: two reference curves,
 * and the one scale that ties radiation to power.
 *
 * ── Why two axes are allowed here, and only like this ───────────────────────
 * Guardrail 22 forbids two y-axes, because two independently fitted scales can
 * be made to line up any way at all, and the chart then asserts a relationship
 * nobody measured — irradiance against power being exactly the pair a reader
 * invents one from. The client's reference chart draws that pair on one frame
 * anyway, and the user asked for it (24 Sep 2026).
 *
 * So the scales are **locked, not fitted**: 1,000 W/m² sits level with the
 * Plant's DC nameplate in kW, because that is what the array makes at
 * standard test conditions. The relationship the reader sees is then one the
 * Plant's own record states, and the gap between the curves means something —
 * it is everything between the nameplate and what arrived at the meter. With
 * no DC capacity recorded there is nothing to lock to, and radiation is not
 * overlaid at all rather than overlaid on a scale somebody picked.
 *
 * ── What "expected" means, and what it does not ─────────────────────────────
 * The client has never supplied an expected-power basis — no design PR, no
 * PVsyst or budget profile, no forecast. These two curves use **nothing that is
 * not measured or recorded**:
 *
 *   Exp Power (DC)   plane-of-array irradiance × DC nameplate ÷ 1,000 W/m² —
 *                    the IEC 61724 reference power, the same denominator PR
 *                    divides by. Lossless, and not temperature-corrected.
 *   Exp Power (AC)   the DC reference through the Inverters at their own
 *                    **measured** efficiency — the median of what they
 *                    reported while generating in the window — limited to the
 *                    AC nameplate.
 *
 * ⚠ The AC reference was first drawn lossless (the DC one, only clipped), and
 * on a Plant that never clips it sat exactly on the DC line. No real Inverter
 * does that: conversion costs 1.5–3%, and the two references must differ by
 * it. The efficiency is the Inverters' own, not an assumed figure, and it is a
 * *median while generating* rather than each bucket's value — an Inverter that
 * trips reports 0%, and letting that pull the reference down with it would hide
 * precisely the loss the reference exists to show.
 *
 * Both are ceilings, not forecasts: a healthy Plant sits below them, and the
 * gap is roughly 1 − PR. They are not the curve a design PR would produce, and
 * when the client names their basis it replaces these.
 */

import type { TrendPoint } from "@/api/useSlotTrend";

/**
 * Standard test conditions: the irradiance at which a module makes its
 * nameplate (IEC 60904-3). A definition, not an assumption about this Plant.
 */
export const STC_IRRADIANCE_W_M2 = 1000;

/** The only units the lock and the reference curves are defined for. */
export const POWER_UNIT = "kW";
export const IRRADIANCE_UNIT = "W/m2";

/** kW of nameplate per W/m² of irradiance: the lock between the two axes. */
export function kwPerWm2(dcCapacityKwp: number | null | undefined): number | null {
  if (dcCapacityKwp === null || dcCapacityKwp === undefined || !(dcCapacityKwp > 0)) return null;
  return dcCapacityKwp / STC_IRRADIANCE_W_M2;
}

/** Plane-of-array irradiance × DC nameplate ÷ STC. A gap stays a gap. */
export function expectedDcKw(irradiance: TrendPoint[], dcCapacityKwp: number): TrendPoint[] {
  const perWm2 = dcCapacityKwp / STC_IRRADIANCE_W_M2;
  return irradiance.map((point) => ({
    ...point,
    // Negative irradiance is a sensor at night reading below zero, not the
    // array consuming power: the reference is zero there, never negative.
    value: point.value === null ? null : Math.max(0, point.value) * perWm2,
  }));
}

/**
 * The Inverters' typical conversion efficiency over a window, as a fraction:
 * the median of their reported efficiency (in %) while generating. Null when
 * they reported nothing above zero — at night, or with no efficiency bound.
 *
 * Above 100% is a reading, not physics, and is left out rather than allowed to
 * lift the reference above its own DC input.
 */
export function medianGeneratingEfficiency(efficiencyPercent: TrendPoint[]): number | null {
  const generating = efficiencyPercent
    .map((point) => point.value)
    .filter((value): value is number => value !== null && value > 0 && value <= 100)
    .sort((a, b) => a - b);
  if (generating.length === 0) return null;
  const middle = Math.floor(generating.length / 2);
  const median =
    generating.length % 2 === 1
      ? generating[middle]!
      : (generating[middle - 1]! + generating[middle]!) / 2;
  return median / 100;
}

/** The DC reference through the Inverters at `efficiency`, limited to the AC nameplate. */
export function expectedAcKw(
  expectedDc: TrendPoint[],
  acCapacityKw: number,
  efficiency: number,
): TrendPoint[] {
  return expectedDc.map((point) => ({
    ...point,
    value: point.value === null ? null : Math.min(point.value * efficiency, acCapacityKw),
  }));
}

/** 1, 2, 2.5 or 5 × 10ⁿ at or above `raw` — the steps an axis reads easily. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= raw) return factor * magnitude;
  }
  return 10 * magnitude;
}

export interface AxisScale {
  min: number;
  max: number;
  interval: number;
}

/**
 * Both axes' scales, locked so a radiation value sits level with its nameplate
 * power. Fitted on the power side — the figure the chart is about — with the
 * radiation side derived from it, so both have the same number of divisions
 * and share every gridline.
 *
 * `power` holds everything drawn in kW; `radiation` everything in W/m².
 */
export function lockedAxes(
  power: number[],
  radiation: number[],
  perWm2: number,
  divisions = 5,
): { power: AxisScale; radiation: AxisScale } {
  const asPower = [...power, ...radiation.map((value) => value * perWm2)].filter(Number.isFinite);
  // An empty chart still gets a frame: 0 to the nameplate, which is 0 to
  // 1,000 W/m² on the other side — the scale the lock is defined by.
  const top = asPower.length > 0 ? Math.max(0, ...asPower) : perWm2 * STC_IRRADIANCE_W_M2;
  const bottom = asPower.length > 0 ? Math.min(0, ...asPower) : 0;
  const step = niceStep((top - bottom || perWm2 * STC_IRRADIANCE_W_M2) / divisions);
  const max = Math.max(step, Math.ceil(top / step) * step);
  const min = Math.floor(bottom / step) * step;
  return {
    power: { min, max, interval: step },
    radiation: { min: min / perWm2, max: max / perWm2, interval: step / perWm2 },
  };
}
