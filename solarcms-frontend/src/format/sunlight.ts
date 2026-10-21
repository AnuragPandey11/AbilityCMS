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

import type { Irradiation, IrradiationStation, PrBasis, WithheldReading } from "@/api/schemas";
import { formatDate, formatTime } from "@/format/datetime";
import { formatNumber } from "@/format/value";

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

/** `11:30–20:00` on one day, with the date unless it is the day `now` is in. */
export function spanWords(
  from: string,
  to: string,
  timeZone?: string,
  now: Date = new Date(),
): string {
  const hhmm = (value: string): string => formatTime(value, timeZone).slice(0, 5);
  const day = formatDate(from, timeZone);
  // A span ending at midnight belongs to the day it began.
  const endDay = formatDate(Date.parse(to) - 1, timeZone);
  if (day === endDay) {
    return day === formatDate(now, timeZone)
      ? `${hhmm(from)}–${hhmm(to)}`
      : `${day.slice(0, 5)} ${hhmm(from)}–${hhmm(to)}`;
  }
  return `${day.slice(0, 5)} ${hhmm(from)} – ${endDay.slice(0, 5)} ${hhmm(to)}`;
}

/**
 * What a PR left out, in words — or null when it stands on all the energy.
 *
 * PR counts only the periods in which both the energy and the sunlight were
 * measured, and sets aside a station reading too little for the output
 * (`domain/pr_matching`, ⚠ proposed). A figure from part of the day is a
 * different claim from one over all of it, so the dial says which.
 */
export function prBasisNote(
  basis: PrBasis | null | undefined,
  timeZone?: string,
  now: Date = new Date(),
): SunlightNote | null {
  if (!basis) return null;
  const left = basis.left_out;
  const aside = basis.stations_set_aside;
  if (left.length === 0 && aside.length === 0) return null;

  const short: string[] = [];
  const full: string[] = [
    "PR counts only the 15-minute periods in which both the energy and the sunlight were " +
      "measured, so a gap drops out of both rather than tilting the figure (proposed).",
  ];
  const share = basis.energy_share;
  if (share !== null && share < 1) {
    short.push(`PR from ${Math.round(share * 100)}% of the energy`);
    full.push(`It stands on ${Math.round(share * 100)}% of the energy recorded.`);
  }
  const first = left[0];
  if (first) {
    short.push(`${first.words} ${spanWords(first.from, first.to, timeZone, now)}`);
    full.push(
      `Left out: ${left
        .map(
          (run) =>
            `${spanWords(run.from, run.to, timeZone, now)}, ${run.words}` +
            (run.energy_kwh > 0 ? ` (${formatNumber(run.energy_kwh, { digits: 0 })} kWh)` : ""),
        )
        .join("; ")}` +
        (basis.left_out_count > left.length
          ? `, and ${basis.left_out_count - left.length} shorter stretch(es).`
          : "."),
    );
  }
  if (aside.length > 0) {
    short.push(`${list(aside.map((s) => s.device_code))} set aside`);
    full.push(
      ...aside.map(
        (s) =>
          `${s.device_code}'s sunlight was set aside for ${formatNumber(s.hours, { digits: 1 })} h ` +
          (s.reads_dark
            ? "as reading no sun while the Plant generated — a dead sensor (see Data Issues)."
            : "as under half what the Plant's output needs — a dirty, shaded or wrongly scaled " +
              "sensor, or a DC capacity or meter on record that is wrong (see Data Issues)."),
      ),
    );
  }
  const text = short.join(" · ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), title: full.join(" "), warn: true };
}

/** Several notes as one line: the first's capital, every title, any warning. */
export function combineNotes(...notes: (SunlightNote | null)[]): SunlightNote | null {
  const present = notes.filter((note): note is SunlightNote => note !== null);
  if (present.length === 0) return null;
  const text = present
    .map((note, index) => (index === 0 ? note.text : note.text.charAt(0).toLowerCase() + note.text.slice(1)))
    .join(" · ");
  return {
    text,
    title: present.map((note) => note.title).join(" "),
    warn: present.some((note) => note.warn),
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
