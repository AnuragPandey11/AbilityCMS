/**
 * Where a PR's sunlight came from, in words.
 *
 * PR divides energy by the sunlight the weather stations measured, and the
 * server (`domain/irradiation`, ⚠ PROPOSED 15 Oct 2026) no longer takes every
 * station at its word: a station whose daily total reads next to nothing while
 * its live GHI sees the sun gives the live GHI, integrated; a station reading no
 * sun beside one that does is left out; stations that disagree are flagged.
 * Each of those changes what the PR figure *is*, so a screen showing PR says so
 * — one line under the dial, in full in the drawer.
 *
 * Nothing to say when every station gave its own total: the line is for the
 * exception, or people stop reading it.
 */

import type { Irradiation, IrradiationStation, WithheldReading } from "@/api/schemas";

export interface SunlightNote {
  /** One short line, for a footnote. */
  text: string;
  /** The full account, for a tooltip. */
  title: string;
  /** A station left out or stations disagreeing: worth a second look. */
  warn: boolean;
}

function list(codes: string[]): string {
  return codes.length <= 1
    ? (codes[0] ?? "")
    : `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

export function sunlightNote(irradiation: Irradiation | null | undefined): SunlightNote | null {
  if (!irradiation) return null;
  const live = irradiation.stations
    .filter((s) => s.excluded_reason === null && s.source === "live_ghi")
    .map((s) => s.device_code);
  const left = irradiation.stations.filter((s) => s.excluded_reason !== null);
  const spread = irradiation.spread ?? null;

  const short: string[] = [];
  const full: string[] = [];
  if (live.length > 0) {
    short.push("sunlight from live GHI");
    full.push(
      `${list(live)}: the daily sunlight total read next to nothing while the live GHI ` +
        "sensor saw the sun, so PR divides by that live GHI added up over the period — " +
        "this platform's arithmetic, not a total the station sent (proposed).",
    );
  }
  if (left.length > 0) {
    short.push(`${list(left.map((s) => s.device_code))} left out`);
    full.push(...left.map((s) => `${s.device_code} is left out: it ${s.excluded_reason}.`));
  }
  if (spread !== null) {
    const percent = Math.round(spread * 100);
    short.push(`stations ${percent}% apart`);
    full.push(
      `The weather stations used differ by ${percent}% — a dirty, shaded or misaligned ` +
        "sensor, or a gap in one of them. Their mean is used; which is right needs checking on site.",
    );
  }
  if (short.length === 0) return null;
  const text = short.join(" · ");
  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    title: full.join(" "),
    warn: left.length > 0 || spread !== null,
  };
}

/** One station's part, for the drawer's list. */
export function stationSourceWords(station: IrradiationStation): string {
  if (station.excluded_reason !== null) return "left out — not measuring";
  if (station.source === "live_ghi") return "live GHI, added up (its daily total read nothing)";
  if (station.source === "register") return "its own daily total";
  return "nothing to read";
}

/** A slot's withheld readings, as a tooltip sentence; null when there are none. */
export function withheldWords(readings: WithheldReading[] | undefined): string | null {
  if (!readings || readings.length === 0) return null;
  return `Held back as not measuring: ${readings
    .map((r) => `${r.device_code}: ${r.reason}`)
    .join("; ")}.`;
}
