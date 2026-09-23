/**
 * Energy per hour, or per day, from the cumulative register behind a headline
 * figure. Pure — the hook that feeds it is `api/useSlotSteps`.
 *
 * The headline cards draw *how* a total accrued: Today's Energy as one spoke per
 * hour, Month Energy as one column per day. Both figures are registers that only
 * count up (`ENERGY_TODAY`, `ENERGY_MONTHLY`), so the energy in a period is the
 * sum of the register's **steps** inside it, never its highest reading minus its
 * lowest — the same rule `domain/counters.py` applies for the reports.
 *
 * ── Why the daily tier is not used for "per day" ────────────────────────────
 * `agg_1d` buckets are cut at UTC midnight, and the register resets at the
 * *Plant's* midnight — for Kolkata, 18:30 UTC, inside the bucket. The bucket's
 * `last` is then a reading taken after the reset, which is not the day's total
 * at all. So days are built from hourly steps and attributed by the Plant's own
 * calendar.
 *
 * ── Three rules, each of which leaves a figure out rather than invent it ────
 * - **Each Device is integrated on its own**, and only then summed. Summing the
 *   Devices first and differencing the sum turns one Inverter that missed a
 *   bucket into a negative hour for the whole Plant.
 * - **A backwards step is not counted** — unless the register restarts by
 *   design. A rollover, a replaced meter and a reset look identical in the
 *   data and mean opposite things (OPEN-14), so the step is skipped and
 *   counted in `backwardsSteps`. A daily register (`ENERGY_TODAY`) drops to
 *   zero every midnight on purpose; with `resetsExpected` the reading after
 *   the drop is what has accrued since, and it counts — the backend's
 *   `integrate_counter(resets_expected=True)`, the same rule.
 * - **A step across a gap is placed only if it stays inside one period.** A
 *   Device silent from 10:00 to 14:00 accrued something in those hours, and
 *   nothing says how it was split — so those hours are unknown for that Device,
 *   and the period is drawn as partial or as a gap rather than as a low bar.
 *
 * A register's first reading in the window has nothing before it to step from,
 * so it is never placed. What went unplaced is the difference between the
 * headline figure and `placed`, and the card states it rather than hiding it.
 *
 * ⚠ An implausibly *large* forward step (a counter that jumped) is not caught
 * here; the reports catch it against rated capacity, and this view would draw
 * it as a tall bar.
 */

export interface RegisterReading {
  deviceId: number;
  /** The bucket's start, epoch ms. */
  bucket: number;
  value: number;
}

export interface Period {
  start: number;
  end: number;
}

/**
 * `current` holds now and is still accruing. `gap` is past and has nothing
 * placed in it. `partial` has fewer Devices than reported in the window.
 */
export type PeriodState = "complete" | "partial" | "gap" | "current" | "future";

export interface PeriodEnergy extends Period {
  /** null where nothing was placed — never 0, which would be a measurement. */
  energy: number | null;
  contributors: number;
  expected: number;
  state: PeriodState;
}

export interface Placement {
  periods: PeriodEnergy[];
  /** Everything placed in some period. The headline figure minus this is what could not be. */
  placed: number;
  backwardsSteps: number;
}

/** Index of the period containing `instant`, or -1. `periods` is ascending and contiguous. */
function periodAt(periods: Period[], instant: number): number {
  let lo = 0;
  let hi = periods.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const period = periods[mid];
    if (instant < period.start) hi = mid - 1;
    else if (instant >= period.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function placeRegisterSteps(
  readings: RegisterReading[],
  periods: Period[],
  {
    stepMs,
    now,
    resetsExpected = false,
  }: {
    stepMs: number;
    now: number;
    /** The register restarts from zero by design — a daily total. */
    resetsExpected?: boolean;
  },
): Placement {
  const byDevice = new Map<number, RegisterReading[]>();
  for (const reading of readings) {
    if (!Number.isFinite(reading.value)) continue;
    const list = byDevice.get(reading.deviceId);
    if (list) list.push(reading);
    else byDevice.set(reading.deviceId, [reading]);
  }

  const energy = periods.map(() => 0);
  const contributors = periods.map(() => new Set<number>());
  let placed = 0;
  let backwardsSteps = 0;

  for (const [deviceId, series] of byDevice) {
    series.sort((a, b) => a.bucket - b.bucket);
    for (let i = 1; i < series.length; i += 1) {
      const before = series[i - 1];
      const after = series[i];
      let delta = after.value - before.value;
      if (delta < 0) {
        if (!resetsExpected) {
          backwardsSteps += 1;
          continue;
        }
        // The register restarted between the two readings; what it reads now
        // is what has accrued since. What accrued before the restart is not
        // known and is not placed.
        delta = after.value;
      }
      // A bucket's reading is its last, taken near its end — so the step runs
      // from the end of the earlier bucket to the end of the later one, capped
      // at now for the bucket still filling.
      const from = Math.min(before.bucket + stepMs, now);
      const to = Math.min(after.bucket + stepMs, now);
      const first = periodAt(periods, from);
      const last = periodAt(periods, to - 1);
      if (last < 0) continue;
      const adjacent = after.bucket - before.bucket <= stepMs * 1.5;
      // Inside one period, or across a boundary by less than one bucket — the
      // later reading's period, which is the backend's convention too.
      if (first === last || adjacent) {
        energy[last] += delta;
        contributors[last].add(deviceId);
        placed += delta;
      }
    }
  }

  const expected = byDevice.size;
  return {
    placed,
    backwardsSteps,
    periods: periods.map((period, index) => {
      const count = contributors[index].size;
      const state: PeriodState =
        period.start >= now
          ? "future"
          : now < period.end
            ? "current"
            : count === 0
              ? "gap"
              : count < expected
                ? "partial"
                : "complete";
      return {
        ...period,
        energy: count > 0 ? energy[index] : null,
        contributors: count,
        expected,
        state,
      };
    }),
  };
}

/**
 * The hourly buckets the server will return across `[start, end)`.
 *
 * TimescaleDB aligns hourly buckets to the UTC hour, so for a zone with a
 * half-hour offset they fall at :30 local — 00:30, 01:30 in Kolkata — and the
 * day's first bucket is the first UTC hour at or after its midnight.
 */
export function hourlyPeriods(start: number, end: number, stepMs = 3_600_000): Period[] {
  const periods: Period[] = [];
  for (let at = Math.ceil(start / stepMs) * stepMs; at < end; at += stepMs) {
    periods.push({ start: at, end: at + stepMs });
  }
  return periods;
}
