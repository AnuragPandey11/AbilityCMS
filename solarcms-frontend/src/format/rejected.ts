/**
 * How a refused reading is shown: as what arrived, marked, never as a reading
 * (Guardrail 33).
 *
 * Every refused value carries three things — the payload key it came under,
 * the number as it arrived, and the range it was judged against — because
 * those are what tell somebody whose fault it is. Check them against the raw
 * message: the raw message says `EFF: "-1"` and the screen says −1, rejected —
 * the equipment sent it, and we passed it on faithfully; the raw message says
 * 98.5 and the screen says something else — a mapping, a scale, or a bug of
 * ours. A calculated Tag that could not be worked out says which input stopped
 * it instead, because the culprit there is that input, not the formula.
 */

import { formatNumber, formatValue } from "./value";

/** `QUALITY_*` in `domain/assumptions.py`. */
const STALE = 2;
const UNPARSEABLE = 3;

/** What was refused. The live frame, a stored reading and a slot all carry this shape. */
export interface Refused {
  /** As it arrived; null when it was empty or not a number, or never calculated. */
  value: number | null;
  quality?: number | null;
  source_key?: string | null;
  valid_min?: number | null;
  valid_max?: number | null;
  /** A calculated Tag: the input Tag whose refusal stopped it. */
  because?: string | null;
  device_code?: string;
  tag_code?: string;
}

/** The value as it arrived — "-1.00 %", "empty", "not calculated" — for where a reading would go. */
export function rejectedValue(entry: Refused, unit: string | null | undefined): string {
  if (entry.because) return "not calculated";
  if (entry.value === null || entry.quality === UNPARSEABLE) return "empty";
  return formatValue(entry.value, unit);
}

function bound(value: number): string {
  return formatNumber(value, { digits: Number.isInteger(value) ? 0 : undefined });
}

/** The sentence beside it: what arrived, and why it is not a reading. */
export function rejectedText(entry: Refused, unit: string | null | undefined): string {
  const tag = entry.tag_code ?? "this Tag";
  if (entry.because) {
    const where = entry.device_code ? ` on ${entry.device_code}` : "";
    return `Not calculated: ${entry.because}${where} was rejected, so ${tag} cannot be worked out from it.`;
  }
  const subject = entry.device_code ? `${entry.device_code} sent` : "Sent";
  const key = entry.source_key ? ` (key ${entry.source_key})` : "";
  const stored = " Stored and flagged; not used in any figure.";
  if (entry.value === null || entry.quality === UNPARSEABLE) {
    return `${subject} ${tag}${key} empty or not a number.${stored}`;
  }
  const arrived = formatValue(entry.value, unit);
  if (entry.quality === STALE) {
    return `${subject} ${tag}${key} = ${arrived} with a timestamp too old to be current.${stored}`;
  }
  const range =
    entry.valid_min !== null && entry.valid_min !== undefined &&
    entry.valid_max !== null && entry.valid_max !== undefined
      ? `; allowed ${bound(entry.valid_min)} to ${bound(entry.valid_max)}${unit ? ` ${unit}` : ""}`
      : ", outside its allowed range";
  return `${subject} ${tag}${key} = ${arrived}${range}.${stored}`;
}
